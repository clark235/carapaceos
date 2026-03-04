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
import { createConnection } from 'net';
import { createSeedISO } from './seed-iso.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SSH_TIMEOUT = 120; // seconds to wait for SSH
const DEFAULT_TASK_TIMEOUT = 300; // seconds for task execution
const DEFAULT_MEMORY = '512';    // MB
const DEFAULT_SSH_PORT_BASE = 12200; // base port, incremented per instance

/**
 * Network modes for VM isolation:
 *
 * - 'nat'      — Full NAT (default). Guest can reach the internet via QEMU SLIRP.
 *                SSH host-forward from host:sshPort → guest:22.
 *
 * - 'isolated' — No outbound network. Guest cannot reach any external hosts.
 *                SSH still works (host-forward is host-side, not guest-initiated).
 *                Uses QEMU `restrict=on` to block all guest-originated traffic.
 *
 * - 'allowlist' — Like isolated, but with specific hosts/ports allowed.
 *                Uses QEMU `restrict=on` + `hostfwd` + `guestfwd` rules.
 *                Specify allowed destinations in opts.networkAllow[].
 *                Each entry: { host, port } — forwarded through QEMU SLIRP.
 *
 * - 'none'     — No network device at all. VM has zero networking.
 *                SSH will NOT work — commands must be injected via seed ISO.
 *                Use for maximum isolation (not practical for most agent tasks).
 */
const NETWORK_MODES = new Set(['nat', 'isolated', 'allowlist', 'none']);

/**
 * Detect the host architecture and return the appropriate QEMU binary + machine flags.
 *
 * Supported:
 *   x64  → qemu-system-x86_64 + '-M pc'
 *   arm64 → qemu-system-aarch64 + '-M virt -cpu cortex-a57'
 *
 * Override via env: CARAPACE_QEMU_BINARY (binary), CARAPACE_QEMU_MACHINE (machine flags).
 */
function detectQemuConfig() {
  const arch = process.env.CARAPACE_ARCH || process.arch;
  const binaryOverride = process.env.CARAPACE_QEMU_BINARY;
  const machineOverride = process.env.CARAPACE_QEMU_MACHINE;

  let binary, machineArgs;

  if (arch === 'arm64' || arch === 'aarch64') {
    binary = 'qemu-system-aarch64';
    machineArgs = ['-M', 'virt', '-cpu', 'cortex-a57'];
  } else {
    // Default: x86_64
    binary = 'qemu-system-x86_64';
    machineArgs = ['-M', 'pc'];
  }

  return {
    binary: binaryOverride || binary,
    machineArgs: machineOverride ? machineOverride.split(' ') : machineArgs,
    detectedArch: arch,
  };
}

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
 * Uses our built-in Node.js ISO generator — no external tools required.
 */
function makeSeedISO(pubKey, outputPath) {
  createSeedISO({
    sshPublicKey: pubKey,
    outputPath,
    hostname: 'carapaceos',
    instanceId: `carapaceos-${Date.now()}`,
  });
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

    // Network isolation mode
    this.networkMode = opts.networkMode || 'nat';
    if (!NETWORK_MODES.has(this.networkMode)) {
      throw new Error(`Invalid networkMode "${this.networkMode}". Valid: ${[...NETWORK_MODES].join(', ')}`);
    }
    // Allowlist entries: [{ host: 'registry.npmjs.org', port: 443 }, ...]
    this.networkAllow = opts.networkAllow || [];
    if (this.networkMode === 'allowlist' && this.networkAllow.length === 0) {
      throw new Error('networkMode "allowlist" requires at least one entry in networkAllow[]');
    }
    // DNS server override (useful for allowlist mode — resolve before restricting)
    this.dnsServer = opts.dnsServer || null;

    // Runtime state
    this._sshPort = allocPort();
    this._workDir = join(tmpdir(), `carapace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    this._overlayImage = join(this._workDir, 'overlay.qcow2');
    this._sshKeyPath = join(this._workDir, 'id_ed25519');
    this._seedISO = join(this._workDir, 'seed.iso');
    this._qmpSocket = join(this._workDir, 'qmp.sock');
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
   * Build QEMU network arguments based on networkMode.
   *
   * QEMU user-mode (SLIRP) networking options:
   *   - `restrict=on`  → blocks ALL guest-initiated outbound connections
   *   - `hostfwd=...`  → host-side port forward (works regardless of restrict)
   *   - `guestfwd=...` → forward guest connections to a specific addr:port
   *                       to an external host (allows selective outbound in restricted mode)
   *   - `dns=<ip>`     → override the DNS server presented to the guest
   *
   * Returns an array of QEMU CLI args (e.g. ['-netdev', 'user,...', '-device', 'virtio-net,...'])
   */
  _buildNetArgs() {
    if (this.networkMode === 'none') {
      // No network device at all — maximum isolation
      this._log('Network mode: none (no network device)');
      return [];
    }

    let netdevSpec = `user,id=net0,hostfwd=tcp::${this._sshPort}-:22`;

    if (this.networkMode === 'isolated') {
      // Block all guest-initiated outbound connections
      // SSH still works because hostfwd is host-side
      netdevSpec += ',restrict=on';
      this._log('Network mode: isolated (restrict=on, no outbound)');
    } else if (this.networkMode === 'allowlist') {
      // Restricted + selective forwarding via guestfwd
      // Each allowed entry creates a guestfwd rule that tunnels
      // guest connections to specific external hosts through QEMU
      netdevSpec += ',restrict=on';

      // guestfwd binds a guest-visible address to an external host.
      // We use 10.0.2.x addresses (QEMU SLIRP internal subnet) for each entry.
      // Guest connects to 10.0.2.100+i:port → QEMU forwards to external host:port.
      for (let i = 0; i < this.networkAllow.length; i++) {
        const { host, port } = this.networkAllow[i];
        if (!host || !port) {
          throw new Error(`networkAllow[${i}] must have { host, port }`);
        }
        // guestfwd: guest connects to guestAddr:port → QEMU proxies to host:port
        const guestAddr = `10.0.2.${100 + i}`;
        netdevSpec += `,guestfwd=tcp:${guestAddr}:${port}-cmd:netcat ${host} ${port}`;
      }

      if (this.dnsServer) {
        netdevSpec += `,dns=${this.dnsServer}`;
      }

      this._log(`Network mode: allowlist (${this.networkAllow.length} rules, restrict=on)`);
      this._log(`  Allowed: ${this.networkAllow.map(e => `${e.host}:${e.port}`).join(', ')}`);
    } else {
      // 'nat' — default, full outbound access
      this._log('Network mode: nat (full outbound access)');
    }

    return [
      '-netdev', netdevSpec,
      '-device', 'virtio-net,netdev=net0',
    ];
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
      this._log('Creating seed ISO (Node.js built-in, no external tools)...');
      makeSeedISO(pubKey, this._seedISO);
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

    // Detect QEMU binary + machine flags for the host architecture
    const { binary: qemuBinary, machineArgs, detectedArch } = detectQemuConfig();
    this._log(`Host arch: ${detectedArch}, QEMU binary: ${qemuBinary}, machine: ${machineArgs.join(' ')}`);

    // Boot QEMU
    this._log('Booting QEMU...');
    const qemuArgs = [
      ...machineArgs,
      '-drive', `file=${this._overlayImage},if=virtio,format=qcow2`,
      '-cdrom', this._seedISO,
      '-m', this.memory,
      '-display', 'none',
      '-serial', 'pipe:/dev/stdin', // capture serial output
      // Network configuration — varies by networkMode
      ...this._buildNetArgs(),
      // QMP monitor socket — enables savevm/loadvm (checkpoint/restore)
      '-qmp', `unix:${this._qmpSocket},server=on,wait=off`,
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
    
    // Fix serial arg  
    const finalArgs = qemuArgs.map(a => 
      a === 'pipe:/dev/stdin' ? `file:${bootLogPath}` : a
    );

    this._qemuProc = spawn(qemuBinary, finalArgs, {
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
   * Send a QMP command to the QEMU monitor and return the response.
   * QMP uses a JSON protocol over a Unix socket.
   *
   * QEMU requires a capability negotiation handshake before commands can be sent:
   *   1. QEMU sends: { "QMP": { ... } }
   *   2. Client sends: { "execute": "qmp_capabilities" }
   *   3. QEMU replies: { "return": {} }
   *   4. Now commands can be sent.
   *
   * @param {string} execute - QMP command name
   * @param {object} [args]  - command arguments
   * @returns {object} - parsed QMP response
   */
  async _qmp(execute, args = undefined) {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this._qmpSocket);
      let buf = '';
      let negotiated = false;

      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error('QMP timeout'));
      }, 10000);

      sock.on('error', err => {
        clearTimeout(timeout);
        reject(new Error(`QMP socket error: ${err.message}`));
      });

      sock.on('data', chunk => {
        buf += chunk.toString();
        // QMP sends one JSON object per line (newline-delimited)
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete last line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }

          if (!negotiated) {
            // First message is the QMP greeting; reply with capability negotiation
            if (msg.QMP) {
              sock.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
            } else if ('return' in msg) {
              // Capability negotiation acknowledged — now send our real command
              negotiated = true;
              const cmd = { execute };
              if (args) cmd.arguments = args;
              sock.write(JSON.stringify(cmd) + '\n');
            }
          } else {
            // Our command response
            clearTimeout(timeout);
            sock.destroy();
            if (msg.error) {
              reject(new Error(`QMP error: ${msg.error.desc}`));
            } else {
              resolve(msg.return ?? msg);
            }
          }
        }
      });
    });
  }

  /**
   * Save a VM snapshot (checkpoint).
   * The snapshot is stored inside the qcow2 overlay image.
   *
   * @param {string} name - snapshot name (e.g. 'before-npm-install')
   * @returns {{ name, timestamp }}
   */
  async saveSnapshot(name) {
    if (!this._booted) throw new Error('VM not booted.');
    if (!name || typeof name !== 'string') throw new Error('Snapshot name is required.');
    // Sanitize: only alphanumeric, hyphens, underscores
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    this._log(`Saving snapshot: ${safeName}`);
    await this._qmp('human-monitor-command', { 'command-line': `savevm ${safeName}` });
    this._log(`Snapshot saved: ${safeName}`);
    return { name: safeName, timestamp: Date.now() };
  }

  /**
   * Restore a VM snapshot (rollback to checkpoint).
   * All changes made after the snapshot was taken are discarded.
   *
   * @param {string} name - snapshot name to restore
   */
  async restoreSnapshot(name) {
    if (!this._booted) throw new Error('VM not booted.');
    if (!name) throw new Error('Snapshot name is required.');
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    this._log(`Restoring snapshot: ${safeName}`);
    await this._qmp('human-monitor-command', { 'command-line': `loadvm ${safeName}` });
    this._log(`Snapshot restored: ${safeName}`);
    // Give the VM a moment to settle after restore
    await new Promise(r => setTimeout(r, 1000));
  }

  /**
   * List all snapshots stored in the overlay image.
   * Uses qemu-img info to query snapshot metadata.
   *
   * @returns {Array<{ name, vmSize, date, clockMs }>}
   */
  async listSnapshots() {
    if (!this._workDir) throw new Error('VM not initialized.');
    // qemu-img info --output=json includes snapshot table
    let raw;
    try {
      raw = sh(`qemu-img info --output=json "${this._overlayImage}"`);
    } catch (e) {
      throw new Error(`qemu-img info failed: ${e.message}`);
    }
    const info = JSON.parse(raw);
    const snapshots = info.snapshots ?? [];
    return snapshots.map(s => ({
      name: s.name,
      vmSize: s['vm-state-size'] ?? 0,
      date: s.date ?? null,
      clockMs: s['clock-ns'] !== undefined ? Math.round(s['clock-ns'] / 1e6) : null,
    }));
  }

  /**
   * Delete a snapshot from the overlay image.
   * @param {string} name
   */
  async deleteSnapshot(name) {
    if (!this._workDir) throw new Error('VM not initialized.');
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    this._log(`Deleting snapshot: ${safeName}`);
    sh(`qemu-img snapshot -d "${safeName}" "${this._overlayImage}"`);
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
      network: {
        mode: this.networkMode,
        allowlist: this.networkAllow.length > 0
          ? this.networkAllow.map(e => `${e.host}:${e.port}`)
          : undefined,
        dns: this.dnsServer || undefined,
      },
    };
  }
}

/**
 * High-level convenience: boot VM, run task, shutdown, return results.
 * 
 * @param {string|string[]} command - command(s) to run
 * @param {object} opts - CarapaceRunner options (including networkMode, networkAllow)
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
