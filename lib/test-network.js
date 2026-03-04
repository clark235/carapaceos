#!/usr/bin/env node
/**
 * Unit tests for CarapaceOS network isolation modes.
 *
 * Tests the _buildNetArgs() method and constructor validation
 * without booting any actual VMs (no QEMU required).
 */

import { CarapaceRunner } from './agent-runner.js';

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'assertEqual'}: got ${a}, expected ${e}`);
}

function assertIncludes(arr, val, msg) {
  if (!arr.includes(val)) {
    throw new Error(`${msg || 'assertIncludes'}: ${JSON.stringify(val)} not found in ${JSON.stringify(arr)}`);
  }
}

function assertNotIncludes(arr, val, msg) {
  if (arr.includes(val)) {
    throw new Error(`${msg || 'assertNotIncludes'}: ${JSON.stringify(val)} unexpectedly found in ${JSON.stringify(arr)}`);
  }
}

function assertThrows(fn, expectedMsg) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      throw new Error(`Expected error containing "${expectedMsg}", got: "${e.message}"`);
    }
  }
  if (!threw) throw new Error(`Expected function to throw (expected: "${expectedMsg}")`);
}

// ─── Helper: create a runner without booting ─────────────────────────────────
// We pass a fake image path since we never actually boot.
const FAKE_IMAGE = '/tmp/fake-carapaceos.qcow2';

function makeRunner(opts = {}) {
  return new CarapaceRunner({ image: FAKE_IMAGE, ...opts });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n🌐 CarapaceOS Network Isolation Tests\n');

// ─── Constructor validation ──────────────────────────────────────────────────

console.log('Constructor validation');

await test('Default networkMode is nat', () => {
  const r = makeRunner();
  assertEqual(r.networkMode, 'nat');
  assertEqual(r.networkAllow, []);
  assertEqual(r.dnsServer, null);
});

await test('Accepts networkMode: nat', () => {
  const r = makeRunner({ networkMode: 'nat' });
  assertEqual(r.networkMode, 'nat');
});

await test('Accepts networkMode: isolated', () => {
  const r = makeRunner({ networkMode: 'isolated' });
  assertEqual(r.networkMode, 'isolated');
});

await test('Accepts networkMode: none', () => {
  const r = makeRunner({ networkMode: 'none' });
  assertEqual(r.networkMode, 'none');
});

await test('Accepts networkMode: allowlist with entries', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'registry.npmjs.org', port: 443 }],
  });
  assertEqual(r.networkMode, 'allowlist');
  assertEqual(r.networkAllow.length, 1);
});

await test('Rejects invalid networkMode', () => {
  assertThrows(() => makeRunner({ networkMode: 'bridge' }), 'Invalid networkMode');
});

await test('Rejects allowlist mode with no entries', () => {
  assertThrows(
    () => makeRunner({ networkMode: 'allowlist', networkAllow: [] }),
    'requires at least one entry'
  );
});

await test('Rejects allowlist mode with undefined networkAllow', () => {
  assertThrows(
    () => makeRunner({ networkMode: 'allowlist' }),
    'requires at least one entry'
  );
});

await test('Accepts dnsServer option', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'example.com', port: 443 }],
    dnsServer: '8.8.8.8',
  });
  assertEqual(r.dnsServer, '8.8.8.8');
});

// ─── _buildNetArgs() ─────────────────────────────────────────────────────────

console.log('\n_buildNetArgs()');

await test('nat mode: returns standard user networking', () => {
  const r = makeRunner({ networkMode: 'nat' });
  const args = r._buildNetArgs();

  assertEqual(args.length, 4, 'Should have 4 args: -netdev, spec, -device, spec');
  assertEqual(args[0], '-netdev');
  assert(args[1].startsWith('user,id=net0,'), 'Should start with user,id=net0,');
  assert(args[1].includes('hostfwd=tcp::'), 'Should include SSH host forward');
  assert(!args[1].includes('restrict=on'), 'Should NOT have restrict=on');
  assertEqual(args[2], '-device');
  assertEqual(args[3], 'virtio-net,netdev=net0');
});

await test('isolated mode: adds restrict=on', () => {
  const r = makeRunner({ networkMode: 'isolated' });
  const args = r._buildNetArgs();

  assertEqual(args.length, 4);
  assert(args[1].includes('restrict=on'), 'Should have restrict=on');
  assert(args[1].includes('hostfwd=tcp::'), 'SSH forward should still be present');
});

await test('none mode: returns empty array (no network device)', () => {
  const r = makeRunner({ networkMode: 'none' });
  const args = r._buildNetArgs();

  assertEqual(args.length, 0, 'No network device should produce empty args');
});

await test('allowlist mode: restrict=on + guestfwd rules', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [
      { host: 'registry.npmjs.org', port: 443 },
      { host: 'github.com', port: 443 },
    ],
  });
  const args = r._buildNetArgs();

  assertEqual(args.length, 4);
  const netdev = args[1];
  assert(netdev.includes('restrict=on'), 'Should have restrict=on');
  assert(netdev.includes('hostfwd=tcp::'), 'SSH forward should still be present');
  assert(netdev.includes('guestfwd=tcp:10.0.2.100:443'), 'First guestfwd at 10.0.2.100');
  assert(netdev.includes('netcat registry.npmjs.org 443'), 'First rule forwards to npmjs');
  assert(netdev.includes('guestfwd=tcp:10.0.2.101:443'), 'Second guestfwd at 10.0.2.101');
  assert(netdev.includes('netcat github.com 443'), 'Second rule forwards to github');
});

await test('allowlist mode with DNS override', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'example.com', port: 80 }],
    dnsServer: '1.1.1.1',
  });
  const args = r._buildNetArgs();

  const netdev = args[1];
  assert(netdev.includes('dns=1.1.1.1'), 'Should include DNS override');
});

await test('allowlist with different ports', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [
      { host: 'api.example.com', port: 8080 },
      { host: 'db.internal', port: 5432 },
    ],
  });
  const args = r._buildNetArgs();
  const netdev = args[1];

  assert(netdev.includes('guestfwd=tcp:10.0.2.100:8080'), 'First rule on port 8080');
  assert(netdev.includes('guestfwd=tcp:10.0.2.101:5432'), 'Second rule on port 5432');
});

await test('SSH port is included in all modes except none', () => {
  for (const mode of ['nat', 'isolated']) {
    const r = makeRunner({ networkMode: mode });
    const args = r._buildNetArgs();
    const netdev = args[1];
    assert(
      netdev.includes(`hostfwd=tcp::${r._sshPort}-:22`),
      `${mode}: SSH port forward should reference allocated port`
    );
  }
});

// ─── info property ────────────────────────────────────────────────────────────

console.log('\ninfo property');

await test('info.network includes mode', () => {
  const r = makeRunner({ networkMode: 'isolated' });
  assertEqual(r.info.network.mode, 'isolated');
});

await test('info.network includes allowlist when set', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'npmjs.org', port: 443 }],
  });
  assertEqual(r.info.network.allowlist, ['npmjs.org:443']);
});

await test('info.network omits allowlist when empty', () => {
  const r = makeRunner({ networkMode: 'nat' });
  assertEqual(r.info.network.allowlist, undefined);
});

await test('info.network includes dns when set', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'x.com', port: 443 }],
    dnsServer: '8.8.4.4',
  });
  assertEqual(r.info.network.dns, '8.8.4.4');
});

await test('info.network omits dns when not set', () => {
  const r = makeRunner();
  assertEqual(r.info.network.dns, undefined);
});

// ─── WarmPool network forwarding ──────────────────────────────────────────────

console.log('\nWarmPool network forwarding');

await test('WarmPool constructor accepts networkMode', async () => {
  const { WarmPool } = await import('./warm-pool.js');
  const pool = new WarmPool({
    image: FAKE_IMAGE,
    size: 1,
    networkMode: 'isolated',
  });
  assertEqual(pool.networkMode, 'isolated');
});

await test('WarmPool constructor defaults to nat', async () => {
  const { WarmPool } = await import('./warm-pool.js');
  const pool = new WarmPool({ image: FAKE_IMAGE });
  assertEqual(pool.networkMode, 'nat');
});

await test('WarmPool constructor accepts networkAllow', async () => {
  const { WarmPool } = await import('./warm-pool.js');
  const pool = new WarmPool({
    image: FAKE_IMAGE,
    size: 1,
    networkMode: 'allowlist',
    networkAllow: [{ host: 'api.test.com', port: 443 }],
  });
  assertEqual(pool.networkAllow.length, 1);
  assertEqual(pool.networkAllow[0].host, 'api.test.com');
});

await test('WarmPool constructor accepts dnsServer', async () => {
  const { WarmPool } = await import('./warm-pool.js');
  const pool = new WarmPool({
    image: FAKE_IMAGE,
    size: 1,
    dnsServer: '9.9.9.9',
  });
  assertEqual(pool.dnsServer, '9.9.9.9');
});

// ─── ControlServer network config ─────────────────────────────────────────────

console.log('\nControlServer network config');

await test('ControlServer stores network options', async () => {
  const { ControlServer } = await import('./control-server.js');
  const server = new ControlServer({
    image: FAKE_IMAGE,
    networkMode: 'isolated',
    networkAllow: [],
    dnsServer: '1.0.0.1',
  });
  assertEqual(server.networkMode, 'isolated');
  assertEqual(server.dnsServer, '1.0.0.1');
});

await test('ControlServer defaults to nat', async () => {
  const { ControlServer } = await import('./control-server.js');
  const server = new ControlServer({ image: FAKE_IMAGE });
  assertEqual(server.networkMode, 'nat');
});

// ─── Health endpoint includes network info ────────────────────────────────────

console.log('\nHealth endpoint network info');

// We need a running test server for this. Let's use the mock approach.
const { ControlServer: CS } = await import('./control-server.js');
const { createServer } = await import('http');

class MockPool {
  async start() {}
  async stop() {}
  stats() { return { warm: 1, booting: 0, active: 0, total: 1, waiters: 0, targetSize: 1, maxSize: 4 }; }
  statusLine() { return '[mock]'; }
}

class TestCS extends CS {
  async start() {
    this.pool = new MockPool();
    this.server = createServer((req, res) => this._dispatch(req, res));
    await new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve());
    });
    this.port = this.server.address().port;
    return this;
  }
}

await test('GET /health includes network config (isolated)', async () => {
  const srv = new TestCS({
    image: FAKE_IMAGE,
    networkMode: 'isolated',
  });
  await srv.start();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    const data = await res.json();
    assertEqual(data.network.mode, 'isolated');
    assertEqual(data.network.allowlist, undefined);
  } finally {
    await srv.stop();
  }
});

await test('GET /health includes network config (allowlist with entries)', async () => {
  const srv = new TestCS({
    image: FAKE_IMAGE,
    networkMode: 'allowlist',
    networkAllow: [
      { host: 'npmjs.org', port: 443 },
      { host: 'github.com', port: 443 },
    ],
  });
  await srv.start();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    const data = await res.json();
    assertEqual(data.network.mode, 'allowlist');
    assertEqual(data.network.allowlist.length, 2);
    assertEqual(data.network.allowlist[0], 'npmjs.org:443');
    assertEqual(data.network.allowlist[1], 'github.com:443');
  } finally {
    await srv.stop();
  }
});

await test('GET /health includes DNS when set', async () => {
  const srv = new TestCS({
    image: FAKE_IMAGE,
    networkMode: 'allowlist',
    networkAllow: [{ host: 'x.com', port: 443 }],
    dnsServer: '8.8.8.8',
  });
  await srv.start();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    const data = await res.json();
    assertEqual(data.network.dns, '8.8.8.8');
  } finally {
    await srv.stop();
  }
});

await test('GET /health network defaults to nat', async () => {
  const srv = new TestCS({ image: FAKE_IMAGE });
  await srv.start();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    const data = await res.json();
    assertEqual(data.network.mode, 'nat');
  } finally {
    await srv.stop();
  }
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

console.log('\nEdge cases');

await test('allowlist with missing host throws', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'ok.com', port: 443 }, { port: 80 }],
  });
  let threw = false;
  try { r._buildNetArgs(); } catch (e) {
    threw = true;
    assert(e.message.includes('must have { host, port }'), `Got: ${e.message}`);
  }
  assert(threw, 'Should throw for missing host');
});

await test('allowlist with missing port throws', () => {
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: [{ host: 'ok.com' }],
  });
  let threw = false;
  try { r._buildNetArgs(); } catch (e) {
    threw = true;
    assert(e.message.includes('must have { host, port }'), `Got: ${e.message}`);
  }
  assert(threw, 'Should throw for missing port');
});

await test('Many allowlist entries use sequential IPs', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push({ host: `host${i}.example.com`, port: 443 + i });
  }
  const r = makeRunner({
    networkMode: 'allowlist',
    networkAllow: entries,
  });
  const args = r._buildNetArgs();
  const netdev = args[1];

  for (let i = 0; i < 10; i++) {
    assert(
      netdev.includes(`guestfwd=tcp:10.0.2.${100 + i}:${443 + i}`),
      `Entry ${i} should use IP 10.0.2.${100 + i} and port ${443 + i}`
    );
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log('\nFailed tests:');
  for (const e of errors) console.log(`  ❌ ${e.name}: ${e.error}`);
}
process.exit(failed === 0 ? 0 : 1);
