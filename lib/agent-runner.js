#!/usr/bin/env node
/**
 * CarapaceOS Agent Runner
 * 
 * Programmatic API for booting CarapaceOS VMs and running agent tasks.
 * This is the core "product" — what makes CarapaceOS useful as an AI substrate.
 * 
 * Usage:
 *   import { CarapaceRunner } from './lib/agent-runner.js';
 *   
 *   const runner = new CarapaceRunner({ image: './carapaceos.qcow2' });
 *   await runner.boot();
 *   const result = await runner.run('node --version');
 *   await runner.shutdown();
 * 
 * Design goals:
 * - Ephemeral VMs (copy-on-write from base image, discard after task)
 * - SSH-based command execution (no agent inside the VM required)
 * - Clean process lifecycle management
 * - Works on Linux/Mac with QEMU
 */

import { spawn, execSync } from 'child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SSH_TIMEOUT = 120; // seconds to wait for SSH
const DEFAULT_TASK_TIMEOUT = 300; // seconds for task execution
const DEFAULT_MEMORY = '512';    // MB
const DEFAULT_SSH_PORT_BASE = 12200; // base port, incremented per instance

let _portCounter = 0;

/**
 * Execute a shell command synchronously, return stdout.
 * Throws on non-zero exit.
 */
function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

/**
 * Find a free TCP port starting from base
 */
function allocPort() {
  // Use random port in range 12200-12299
  return DEFAULT_SSH_PORT_BASE + (_portCounter++ % 100);
}

/**
 * Create a temporary overlay image (copy-on-write on top of base)
 * so each VM run is isolated and doesn't modify the base image.
 */
function createOverlay(baseImage, overlayPath) {
  sh(`qemu-img create -f qcow2 -b "${resolve(baseImage)}" -F qcow2 "${overlayPath}"`);
}

/**
 * Generate a fresh ephemeral SSH key pair
 */
function generateSSHKey(keyPath) {
  if (existsSync(keyPath)) unlinkSync(keyPath);
  if (existsSync(keyPath + '.pub')) unlinkSync(keyPath + '.pub');
  sh(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "carapaceos-ephemeral" 2>/dev/null`);
  return readFileSync(keyPath + '.pub', 'utf8').trim();
}

/**
 * Create a minimal cloud-init seed ISO with a given SSH public key.
 * Uses genisoimage or mkisofs (fallback).
 */
function createSeedISO(pubKey, outputPath) {
  const tmpDir = join(tmpdir(), `carapace-seed-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  writeFileSync(join(tmpDir, 'meta-data'), [
    'instance-id: carapaceos-ephemeral',
    'local-hostname: carapaceos',
  ].join('\n') + '\n');

  writeFileSync(join(tmpDir, 'user-data'), [
    '#cloud-config',
    'ssh_authorized_keys:',
    `  - ${pubKey}`,
    'ssh_pwauth: false',
    'runcmd:',
    '  - echo "CARAPACEOS_READY" > /dev/ttyS0',
  ].join('\n') + '\n');

  // Try genisoimage, then mkisofs, then xorriso
  const tools = ['genisoimage', 'mkisofs'];
  let made = false;
  for (const tool of tools) {
    try {
      sh(`which ${tool} 2>/dev/null`);
      sh(`${tool} -output "${outputPath}" -volid cidata -joliet -rock "${tmpDir}" 2>/dev/null`);
      made = true;
      break;
    } catch { /* try next */ }
  }
  if (!made) {
    // xorriso fallback
    try {
      sh(`xorriso -as mkisofs -output "${outputPath}" -volid cidata -joliet -rock "${tmpDir}" 2>/dev/null`);
    } catch {
      throw new Error('No ISO creation tool found. Install genisoimage, mkisofs, or xorriso.');
    }
  }

  // Cleanup tmpdir
  sh(`rm -rf "${tmpDir}"`);
}

/**
 * Check if a TCP port is open (SSH available)
 */
async function waitForPort(port, host = '127.0.0.1', timeoutMs = 120000) {
  const { createConnection } = await import('net');
  const start = Date.now();
  
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(attempt, 2000);
        }
      });
    };
    attempt();
  });
}

/**
 * Run SSH command, return { stdout, stderr, code }
 */
function sshExec(sshArgs, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = [
      ...sshArgs,
      command,
    ];
    
    const proc = spawn('ssh', args, { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    
    proc.on('close', code => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    
    proc.on('error', err => reject(err));
  });
}

/**
 * Main CarapaceRunner class
 */
export class CarapaceRunner {
  constructor(opts = {}) {
    this.baseImage = opts.image || join(__dirname, '../vm-image/carapaceos.qcow2');
    this.memory = opts.memory || DEFAULT_MEMORY;
    this.sshTimeout = (opts.sshTimeout || DEFAULT_SSH_TIMEOUT) * 1000;
    this.taskTimeout = (opts.taskTimeout || DEFAULT_TASK_TIMEOUT) * 1000;
    this.user = opts.user || 'agent';
    this.verbose = opts.verbose || false;
    // KVM: opt.enableKVM → env CARAPACE_ENABLE_KVM → default true
    const kvmEnv = process.env.CARAPACE_ENABLE_KVM;
    this.enableKVM = opts.enableKVM !== undefined
      ? opts.enableKVM
      : (kvmEnv !== undefined ? kvmEnv !== 'false' : true);
    
    // Runtime state
    this._sshPort = allocPort();
    this._workDir = join(tmpdir(), `carapace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    this._overlayImage = join(this._workDir, 'overlay.qcow2');
    this._sshKeyPath = join(this._workDir, 'id_ed25519');
    this._seedISO = join(this._workDir, 'seed.iso');
    this._qemuProc = null;
    this._bootLog = '';
    this._booted = false;
    
    // SSH args (reusable)
    this._sshArgs = null;
  }

  _log(...args) {
    if (this.verbose) console.error('[CarapaceRunner]', ...args);
  }

  /**
   * Boot the VM. Returns when SSH is available.
   */
  async boot() {
    mkdirSync(this._workDir, { recursive: true });
    this._log(`Work dir: ${this._workDir}`);
    this._log(`SSH port: ${this._sshPort}`);

    // Check if existing seed ISO is available (pre-built with our key)
    const existingSeed = join(dirname(this.baseImage), 'build', 'seed.iso');
    const existingKey = join(dirname(this.baseImage), 'build', 'test_key');

    let usingExistingKey = false;
    if (existsSync(existingSeed) && existsSync(existingKey)) {
      // Use pre-built seed + key (faster, avoids ISO creation tool requirement)
      copyFileSync(existingSeed, this._seedISO);
      copyFileSync(existingKey, this._sshKeyPath);
      sh(`chmod 600 "${this._sshKeyPath}"`);
      usingExistingKey = true;
      this._log('Using pre-built seed ISO and SSH key');
    } else {
      // Generate fresh key + seed
      this._log('Generating fresh SSH key...');
      const pubKey = generateSSHKey(this._sshKeyPath);
      this._log('Creating seed ISO...');
      createSeedISO(pubKey, this._seedISO);
    }

    // Create overlay (copy-on-write, base image untouched)
    this._log('Creating overlay image...');
    createOverlay(this.baseImage, this._overlayImage);

    // SSH args
    this._sshArgs = [
      '-i', this._sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', `ConnectTimeout=10`,
      '-p', String(this._sshPort),
      `${this.user}@127.0.0.1`,
    ];

    // Boot QEMU
    this._log('Booting QEMU...');
    const qemuArgs = [
      '-drive', `file=${this._overlayImage},if=virtio,format=qcow2`,
      '-cdrom', this._seedISO,
      '-m', this.memory,
      '-display', 'none',
      '-serial', 'pipe:/dev/stdin', // capture serial output
      '-netdev', `user,id=net0,hostfwd=tcp::${this._sshPort}-:22`,
      '-device', 'virtio-net,netdev=net0',
    ];

    if (this.enableKVM) {
      try {
        sh('test -r /dev/kvm');
        qemuArgs.push('-enable-kvm');
        this._log('KVM enabled');
      } catch {
        this._log('KVM not available, using TCG (slower)');
      }
    }

    // Boot in background, capture serial output for debugging
    const bootLogPath = join(this._workDir, 'boot.log');
    const qemuArgsWithSerial = qemuArgs
      .map(a => a === 'pipe:/dev/stdin' ? `file:${bootLogPath}` : a)
      .map(a => a.includes('pipe:/dev/stdin') ? a : a);
    
    // Fix serial arg  
    const finalArgs = qemuArgs.map(a => 
      a === 'pipe:/dev/stdin' ? `file:${bootLogPath}` : a
    );

    this._qemuProc = spawn('qemu-system-x86_64', finalArgs, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    });

    this._qemuProc.on('exit', (code) => {
      this._log(`QEMU exited with code ${code}`);
      this._booted = false;
    });

    // Wait for SSH port to open
    this._log(`Waiting for SSH on port ${this._sshPort}...`);
    await waitForPort(this._sshPort, '127.0.0.1', this.sshTimeout);

    // Wait for SSH to actually accept connections (a few more seconds)
    await this._waitForSSH();

    this._booted = true;
    this._log('VM booted successfully');
    return this;
  }

  async _waitForSSH(maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const r = await sshExec(this._sshArgs, 'echo SSH_OK', 8000);
        if (r.stdout.includes('SSH_OK')) return;
      } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('SSH never became ready');
  }

  /**
   * Run a shell command inside the VM.
   * Returns { stdout, stderr, code, duration }
   */
  async run(command, opts = {}) {
    if (!this._booted) throw new Error('VM not booted. Call boot() first.');
    
    const timeoutMs = opts.timeout ? opts.timeout * 1000 : this.taskTimeout;
    const start = Date.now();
    
    const result = await sshExec(this._sshArgs, command, timeoutMs);
    result.duration = Date.now() - start;
    
    return result;
  }

  /**
   * Upload a file to the VM
   */
  async upload(localPath, remotePath) {
    if (!this._booted) throw new Error('VM not booted.');
    
    return new Promise((resolve, reject) => {
      const scpArgs = [
        '-i', this._sshKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-P', String(this._sshPort),
        localPath,
        `${this.user}@127.0.0.1:${remotePath}`,
      ];
      
      const proc = spawn('scp', scpArgs);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`scp failed with code ${code}`));
      });
    });
  }

  /**
   * Download a file from the VM
   */
  async download(remotePath, localPath) {
    if (!this._booted) throw new Error('VM not booted.');
    
    return new Promise((resolve, reject) => {
      const scpArgs = [
        '-i', this._sshKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-P', String(this._sshPort),
        `${this.user}@127.0.0.1:${remotePath}`,
        localPath,
      ];
      
      const proc = spawn('scp', scpArgs);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`scp failed with code ${code}`));
      });
    });
  }

  /**
   * Run a multi-step task with structured output.
   * Each step is { name, command, optional } 
   */
  async runTask(steps) {
    const results = [];
    for (const step of steps) {
      this._log(`Running step: ${step.name}`);
      try {
        const r = await this.run(step.command, step.opts);
        results.push({ name: step.name, ...r, success: r.code === 0 });
        if (r.code !== 0 && !step.optional) {
          throw new Error(`Step "${step.name}" failed (exit ${r.code}): ${r.stderr}`);
        }
      } catch (err) {
        if (step.optional) {
          results.push({ name: step.name, success: false, error: err.message });
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  /**
   * Shutdown the VM and clean up temporary files.
   */
  async shutdown(keepWorkDir = false) {
    if (this._qemuProc) {
      try {
        // Graceful shutdown via SSH first
        await sshExec(this._sshArgs, 'sudo poweroff', 3000).catch(() => {});
      } catch { /* ignore */ }
      
      // Give it 3 seconds, then kill
      await new Promise(r => setTimeout(r, 3000));
      
      try {
        this._qemuProc.kill('SIGTERM');
      } catch { /* already dead */ }
      
      this._qemuProc = null;
    }
    
    this._booted = false;
    
    if (!keepWorkDir) {
      // Copy boot log to /tmp for CI artifact collection before cleanup
      const bootLogSrc = join(this._workDir, 'boot.log');
      if (existsSync(bootLogSrc)) {
        const dest = join(tmpdir(), `carapace-${Date.now()}.log`);
        try { copyFileSync(bootLogSrc, dest); } catch { /* best effort */ }
      }
      try {
        sh(`rm -rf "${this._workDir}"`);
      } catch { /* best effort */ }
    }
  }

  /**
   * Get VM info
   */
  get info() {
    return {
      baseImage: this.baseImage,
      memory: this.memory,
      sshPort: this._sshPort,
      workDir: this._workDir,
      booted: this._booted,
    };
  }
}

/**
 * High-level convenience: boot VM, run task, shutdown, return results.
 * 
 * @param {string|string[]} command - command(s) to run
 * @param {object} opts - CarapaceRunner options
 * @returns {object} - { results, stdout, stderr, code }
 */
export async function runIsolated(command, opts = {}) {
  const runner = new CarapaceRunner({ verbose: true, ...opts });
  
  try {
    await runner.boot();
    
    if (typeof command === 'string') {
      const result = await runner.run(command);
      return result;
    } else {
      // Array of { name, command } steps
      return await runner.runTask(command);
    }
  } finally {
    await runner.shutdown();
  }
}
