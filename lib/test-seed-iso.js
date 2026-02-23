#!/usr/bin/env node
/**
 * Unit tests for seed-iso.js — ISO 9660 cloud-init seed generator
 *
 * Tests:
 *   1. ISO magic bytes correct
 *   2. Volume label = CIDATA
 *   3. meta-data content embedded
 *   4. user-data content embedded
 *   5. SSH key injected into user-data
 *   6. Custom hostname reflected
 *   7. runcmd commands present
 *   8. ISO is parseable by `file` command (if available)
 *   9. Multiple ISOs created (no state leakage between calls)
 *  10. Missing sshPublicKey throws
 *  11. Missing outputPath throws
 */

import { createSeedISO, buildISO } from './seed-iso.js';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function assertThrows(label, fn) {
  try {
    fn();
    console.error(`  ❌ ${label}: expected throw, got none`);
    failed++;
  } catch (e) {
    console.log(`  ✅ ${label} (threw: ${e.message})`);
    passed++;
  }
}

function tmpIso(suffix = '') {
  return join(tmpdir(), `carapace-test${suffix}-${Date.now()}.iso`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readISO(path) {
  const buf = readFileSync(path);
  const sector16 = buf.slice(2048 * 16);
  return {
    buf,
    magic: sector16.slice(1, 6).toString('ascii'),
    volLabel: sector16.slice(40, 72).toString('ascii').trim(),
    content: buf.toString('utf8'),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n🦞 seed-iso.js Unit Tests\n');

const TEST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTestKey12345 carapaceos-test';

// Test 1-7: basic ISO creation
{
  const out = tmpIso('basic');
  createSeedISO({
    sshPublicKey: TEST_KEY,
    outputPath: out,
    hostname: 'myvm',
    runcmd: ['echo ready', 'touch /tmp/done'],
  });

  const { magic, volLabel, content, buf } = readISO(out);

  assert('ISO file created', existsSync(out));
  assert('ISO size is multiple of 2048', buf.length % 2048 === 0, `size=${buf.length}`);
  assert('ISO magic = CD001', magic === 'CD001', `got: ${magic}`);
  assert('Volume label = CIDATA', volLabel === 'CIDATA', `got: ${volLabel}`);
  assert('meta-data embedded (instance-id)', content.includes('instance-id:'));
  assert('user-data embedded (#cloud-config)', content.includes('#cloud-config'));
  assert('SSH key injected', content.includes('ssh-ed25519'));
  assert('SSH key value correct', content.includes('AAAAC3NzaC1lZDI1NTE5'));
  assert('Custom hostname in meta-data', content.includes('myvm'));
  assert('runcmd echo present', content.includes('echo ready'));
  assert('runcmd touch present', content.includes('/tmp/done'));
  assert('ssh_pwauth: false present', content.includes('ssh_pwauth: false'));

  unlinkSync(out);
}

// Test: state isolation (two consecutive ISOs have different instance-ids)
{
  const out1 = tmpIso('iso1');
  const out2 = tmpIso('iso2');

  createSeedISO({ sshPublicKey: TEST_KEY, outputPath: out1, hostname: 'vm1' });
  // Small delay to ensure different timestamp
  const t = Date.now(); while (Date.now() - t < 5) {}
  createSeedISO({ sshPublicKey: TEST_KEY, outputPath: out2, hostname: 'vm2' });

  const c1 = readFileSync(out1).toString('utf8');
  const c2 = readFileSync(out2).toString('utf8');

  assert('ISO1 has vm1 hostname', c1.includes('vm1'));
  assert('ISO2 has vm2 hostname', c2.includes('vm2'));
  assert('ISO1 does not have vm2 hostname', !c1.includes('vm2'));
  assert('Two ISOs have different instance-ids', !c1.includes(c2.match(/instance-id: (carapaceos-\d+)/)?.[1] || 'NOMATCH'));

  unlinkSync(out1);
  unlinkSync(out2);
}

// Test: no runcmd (minimal)
{
  const out = tmpIso('minimal');
  createSeedISO({ sshPublicKey: TEST_KEY, outputPath: out });
  const { content } = readISO(out);
  assert('Minimal ISO: CARAPACEOS_READY runcmd present', content.includes('CARAPACEOS_READY'));
  assert('Minimal ISO: valid without extra runcmd', content.includes('#cloud-config'));
  unlinkSync(out);
}

// Test: error cases
assertThrows('Missing sshPublicKey throws', () => {
  createSeedISO({ outputPath: '/tmp/nope.iso' });
});

assertThrows('Missing outputPath throws', () => {
  createSeedISO({ sshPublicKey: TEST_KEY });
});

// Test: buildISO directly with custom files
{
  const out = tmpIso('custom');
  buildISO(
    [
      { name: 'meta-data', isoName: 'META-DATA.;1', content: 'instance-id: test\n' },
      { name: 'user-data', isoName: 'USER-DATA.;1', content: '#cloud-config\n' },
    ],
    out,
    'cidata'
  );
  const { magic, volLabel } = readISO(out);
  assert('buildISO: CD001 magic', magic === 'CD001');
  assert('buildISO: CIDATA label', volLabel === 'CIDATA');
  unlinkSync(out);
}

// Optional: system `file` command validation
try {
  const out = tmpIso('syscheck');
  createSeedISO({ sshPublicKey: TEST_KEY, outputPath: out });
  const fileOut = execSync(`file "${out}" 2>/dev/null`, { encoding: 'utf8' }).trim();
  assert('System `file` recognizes as ISO 9660', fileOut.toLowerCase().includes('iso 9660'), fileOut);
  unlinkSync(out);
} catch {
  console.log('  ℹ️  Skipping `file` command check (not available)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks\n`);

if (failed === 0) {
  console.log('🎉 All seed-iso tests passed!\n');
} else {
  console.error(`💥 ${failed} test(s) failed\n`);
  process.exit(1);
}
