#!/usr/bin/env node
/**
 * carapace-doctor — CarapaceOS Environment Diagnostic
 *
 * Checks everything needed to build and run CarapaceOS VMs:
 *   - QEMU (qemu-system-x86_64, qemu-img)
 *   - ISO creation tools (genisoimage / mkisofs / xorriso)
 *   - SSH client
 *   - KVM availability
 *   - VM image presence
 *   - Node.js version
 *
 * Usage:
 *   node lib/doctor.js
 *   carapace-doctor          (after npm install -g)
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Colors ─────────────────────────────────────────────────────────────────
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

const CHECK = c.green('✓');
const WARN  = c.yellow('⚠');
const FAIL  = c.red('✗');
const INFO  = c.cyan('ℹ');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function which(cmd) {
  try {
    return execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function runVersion(cmd, args = ['--version']) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return out.split('\n')[0].trim();
  } catch (e) {
    // Some tools print version to stderr
    return e.stderr?.split('\n')[0]?.trim() || null;
  }
}

function checkFile(path, label) {
  if (existsSync(path)) {
    const { size } = statSync(path);
    const mb = (size / 1024 / 1024).toFixed(1);
    return { ok: true, detail: `${label} (${mb} MB)` };
  }
  return { ok: false, detail: `${label} — not found at ${path}` };
}

// ─── Checks ──────────────────────────────────────────────────────────────────

const checks = [];

function check(label, fn) {
  checks.push({ label, fn });
}

check('Node.js version', () => {
  const major = parseInt(process.version.slice(1));
  if (major >= 22) return { ok: true, detail: `${process.version} (node:sqlite available)` };
  if (major >= 18) return { ok: 'warn', detail: `${process.version} — works but Node 22+ recommended (node:sqlite)` };
  return { ok: false, detail: `${process.version} — Node 18+ required` };
});

check('QEMU system emulator', () => {
  // Pick the right binary based on host architecture
  const arch = process.env.CARAPACE_ARCH || process.arch;
  let primaryBinary, fallbackBinary, installHint;

  if (arch === 'arm64' || arch === 'aarch64') {
    primaryBinary = 'qemu-system-aarch64';
    fallbackBinary = 'qemu-system-x86_64';
    installHint = 'apt install qemu-system-arm / brew install qemu';
  } else {
    primaryBinary = 'qemu-system-x86_64';
    fallbackBinary = 'qemu-system-aarch64';
    installHint = 'apt install qemu-system-x86 / brew install qemu';
  }

  const binaryOverride = process.env.CARAPACE_QEMU_BINARY;
  const target = binaryOverride || primaryBinary;

  const path = which(target);
  if (!path) {
    // Warn about fallback availability
    const fallbackPath = which(fallbackBinary);
    const extra = fallbackPath
      ? ` (${fallbackBinary} found — set CARAPACE_QEMU_BINARY=${fallbackBinary} to use it for cross-arch emulation)`
      : '';
    return { ok: false, detail: `${target} not found — install: ${installHint}${extra}` };
  }

  const ver = runVersion(target);
  const archNote = binaryOverride ? ` (override via CARAPACE_QEMU_BINARY)` : ` (detected arch: ${arch})`;
  return { ok: true, detail: `${ver || target} at ${path}${archNote}` };
});

check('qemu-img', () => {
  const path = which('qemu-img');
  if (!path) return { ok: false, detail: 'Not found (part of qemu-utils package)' };
  const ver = runVersion('qemu-img');
  return { ok: true, detail: ver || path };
});

check('ISO creation tool', () => {
  // First check: built-in Node.js ISO creator (preferred, zero-dependency)
  const nodeCreator = join(ROOT, 'vm-image', 'create-seed-iso.js');
  if (existsSync(nodeCreator)) {
    return { ok: true, detail: `create-seed-iso.js (Node.js, zero-dependency) at ${nodeCreator}` };
  }
  // Fallback: system tools
  for (const tool of ['genisoimage', 'mkisofs', 'xorriso', 'cloud-localds']) {
    const p = which(tool);
    if (p) {
      const ver = runVersion(tool);
      return { ok: true, detail: `${tool} found — ${ver || p}` };
    }
  }
  return {
    ok: false,
    detail: 'No ISO tool found — create-seed-iso.js missing AND no system tools. Run: apt install genisoimage',
  };
});

check('SSH client', () => {
  const path = which('ssh');
  if (!path) return { ok: false, detail: 'ssh not found (install openssh-client)' };
  const ver = runVersion('ssh', ['-V']);
  return { ok: true, detail: ver || path };
});

check('ssh-keygen', () => {
  const path = which('ssh-keygen');
  if (!path) return { ok: false, detail: 'ssh-keygen not found' };
  return { ok: true, detail: path };
});

check('KVM acceleration', () => {
  if (existsSync('/dev/kvm')) {
    try {
      // Check if we can read it (i.e., have permissions)
      execSync('ls -la /dev/kvm 2>/dev/null', { encoding: 'utf8' });
      return { ok: true, detail: '/dev/kvm available — hardware acceleration enabled (~25s boot)' };
    } catch {
      return { ok: 'warn', detail: '/dev/kvm exists but may lack permissions — add user to kvm group: sudo adduser $(whoami) kvm' };
    }
  }
  if (process.platform === 'darwin') {
    return { ok: 'warn', detail: 'macOS — using Hypervisor.framework via QEMU (no /dev/kvm needed)' };
  }
  return { ok: 'warn', detail: '/dev/kvm not found — TCG fallback (~90s boot). Enable KVM or use a Linux VM.' };
});

check('CarapaceOS base image', () => {
  const imagePath = join(ROOT, 'vm-image', 'carapaceos.qcow2');
  const result = checkFile(imagePath, 'carapaceos.qcow2');
  if (result.ok) return result;
  return {
    ok: 'warn',
    detail: `Image not built yet — run: npm run build-image`,
  };
});

check('Build script', () => {
  const script = join(ROOT, 'vm-image', 'build-image.sh');
  if (existsSync(script)) return { ok: true, detail: script };
  return { ok: false, detail: `Missing: ${script}` };
});

check('cloud-init seed creator', () => {
  const script = join(ROOT, 'vm-image', 'create-seed-iso.js');
  if (existsSync(script)) return { ok: true, detail: script };
  return { ok: false, detail: `Missing: ${script}` };
});

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  if (!jsonMode) {
    console.log('');
    console.log(c.bold('🦞 carapace-doctor — CarapaceOS Environment Check'));
    console.log(c.dim('─'.repeat(54)));
  }

  const results = [];
  let warnings = 0;
  let failures = 0;

  for (const { label, fn } of checks) {
    let result;
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, detail: `Check threw: ${e.message}` };
    }

    const { ok, detail } = result;

    if (ok === true) {
      if (!jsonMode) console.log(`  ${CHECK} ${c.bold(label)}: ${c.dim(detail)}`);
    } else if (ok === 'warn') {
      warnings++;
      if (!jsonMode) console.log(`  ${WARN} ${c.bold(label)}: ${c.yellow(detail)}`);
    } else {
      failures++;
      if (!jsonMode) console.log(`  ${FAIL} ${c.bold(label)}: ${c.red(detail)}`);
    }

    results.push({ label, ok, detail });
  }

  if (jsonMode) {
    console.log(JSON.stringify({ results, warnings, failures }, null, 2));
    process.exit(failures > 0 ? 1 : 0);
  }

  console.log(c.dim('─'.repeat(54)));

  if (failures === 0 && warnings === 0) {
    console.log(`\n  ${CHECK} ${c.green('All checks passed!')} CarapaceOS is ready.\n`);
  } else if (failures === 0) {
    console.log(`\n  ${WARN} ${c.yellow(`${warnings} warning(s)`)} — CarapaceOS should work, but review above.\n`);
  } else {
    console.log(`\n  ${FAIL} ${c.red(`${failures} failure(s), ${warnings} warning(s)`)} — fix issues before running.\n`);
    console.log(`  ${INFO} Run ${c.cyan('npm run build-image')} to build the VM image if not present.\n`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(c.red(`Doctor failed: ${e.message}`));
  process.exit(1);
});
