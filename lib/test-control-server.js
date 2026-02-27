#!/usr/bin/env node
/**
 * Unit tests for ControlServer — no QEMU required.
 *
 * We mock the WarmPool and CarapaceRunner so these tests run on any machine.
 * Tests cover: routing, acquire/run/release lifecycle, metrics, error handling.
 */

// ─── Minimal fetch polyfill (Node 18+) ───────────────────────────────────────
const { default: fetch } = await import('node:http').then(() => import('undici'))
  .catch(() => ({ default: globalThis.fetch }));

// ─── Mock WarmPool + CarapaceRunner ──────────────────────────────────────────

class MockVM {
  constructor(id) {
    this._id = id;
    this._booted = true;
    this._calls = [];
  }

  async run(command, opts = {}) {
    this._calls.push(command);
    if (command === 'exit 1') return { stdout: '', stderr: 'forced error', code: 1, duration: 5 };
    if (command.startsWith('echo ')) {
      const text = command.slice(5).replace(/^"|"$/g, '').trim();
      return { stdout: text, stderr: '', code: 0, duration: 10 };
    }
    return { stdout: `mock output for: ${command}`, stderr: '', code: 0, duration: 20 };
  }

  async runPipeline(commands) {
    const results = [];
    for (const cmd of commands) results.push(await this.run(cmd));
    return results;
  }

  async shutdown() {
    this._booted = false;
  }
}

class MockWarmPool {
  constructor(opts = {}) {
    this.targetSize = opts.size ?? 2;
    this._vmCounter = 0;
    this._acquired = [];
  }

  async start() {}

  async acquire({ timeoutMs } = {}) {
    if (this._simulateExhausted) throw new Error('Pool exhausted');
    const vm = new MockVM(`mock-vm-${this._vmCounter++}`);
    this._acquired.push(vm);
    return vm;
  }

  async release(vm) {
    await vm.shutdown();
    const idx = this._acquired.indexOf(vm);
    if (idx !== -1) this._acquired.splice(idx, 1);
  }

  async stop() {}

  stats() {
    return {
      warm: this.targetSize,
      booting: 0,
      active: this._acquired.length,
      total: this.targetSize + this._acquired.length,
      waiters: 0,
      targetSize: this.targetSize,
      maxSize: 8,
    };
  }

  statusLine() {
    return `[WarmPool] warm=${this.targetSize} booting=0 active=${this._acquired.length} waiters=0`;
  }
}

// ─── Patch ControlServer to use mocks ────────────────────────────────────────

// We'll import ControlServer and monkey-patch it to inject MockWarmPool
// by temporarily swapping the constructor.

const originalModule = await import('./control-server.js');
const { ControlServer: OriginalControlServer } = originalModule;

class TestControlServer extends OriginalControlServer {
  async start() {
    // Replace WarmPool with mock (don't actually start QEMU)
    this.pool = new MockWarmPool({ size: this.poolSize });
    await this.pool.start();

    // Start HTTP server only
    const { createServer } = await import('http');
    this.server = createServer((req, res) => this._dispatch(req, res));
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, err => err ? reject(err) : resolve());
    });

    return this;
  }
}

// ─── Test runner ─────────────────────────────────────────────────────────────

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Expected equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

const PORT = 17375; // Use non-standard port for tests
const BASE = `http://127.0.0.1:${PORT}`;

const server = new TestControlServer({
  image: '/fake/carapaceos.qcow2',
  port: PORT,
  poolSize: 2,
  verbose: false,
});

console.log('\n🦞 CarapaceOS ControlServer Tests\n');

await server.start();
console.log('  Server started on', BASE);
console.log('');

// ─── Health & Discovery ───────────────────────────────────────────────────────
console.log('Health & Discovery');

await test('GET /health returns 200', async () => {
  const res = await fetch(`${BASE}/health`);
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.status, 'ok', 'body.status');
  assert(typeof body.uptime === 'number', 'body.uptime is number');
  assert(body.pool !== null, 'body.pool exists');
});

await test('GET /health includes activeVMs count', async () => {
  const body = await fetch(`${BASE}/health`).then(r => r.json());
  assertEqual(body.activeVMs, 0, 'no active VMs initially');
});

await test('GET /metrics returns text/plain with counters', async () => {
  const res = await fetch(`${BASE}/metrics`);
  assertEqual(res.status, 200, 'status');
  assert(res.headers.get('content-type').includes('text/plain'), 'content-type');
  const text = await res.text();
  assert(text.includes('carapace_acquire_total'), 'has acquire counter');
  assert(text.includes('carapace_run_total'), 'has run counter');
  assert(text.includes('carapace_active_vms'), 'has active vms gauge');
  assert(text.includes('carapace_uptime_seconds'), 'has uptime gauge');
});

await test('GET /vms returns empty list initially', async () => {
  const body = await fetch(`${BASE}/vms`).then(r => r.json());
  assertEqual(body.total, 0, 'total=0');
  assert(Array.isArray(body.vms), 'vms is array');
});

await test('GET /pool/status returns pool stats', async () => {
  const body = await fetch(`${BASE}/pool/status`).then(r => r.json());
  assert(typeof body.warm === 'number', 'has warm');
  assert(typeof body.booting === 'number', 'has booting');
  assert(typeof body.statusLine === 'string', 'has statusLine');
});

await test('404 on unknown routes', async () => {
  const res = await fetch(`${BASE}/does-not-exist`);
  assertEqual(res.status, 404, 'status');
});

// ─── VM Lifecycle ─────────────────────────────────────────────────────────────
console.log('\nVM Lifecycle');

let vmId;

await test('POST /vms/acquire returns vmId and endpoints', async () => {
  const res = await fetch(`${BASE}/vms/acquire`, { method: 'POST' });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assert(typeof body.vmId === 'string', 'has vmId');
  assert(body.endpoints?.run, 'has run endpoint');
  assert(body.endpoints?.pipeline, 'has pipeline endpoint');
  assert(body.endpoints?.release, 'has release endpoint');
  vmId = body.vmId;
});

await test('POST /vms/acquire increments activeVMs', async () => {
  const health = await fetch(`${BASE}/health`).then(r => r.json());
  assertEqual(health.activeVMs, 1, 'one active VM');
});

await test('GET /vms shows acquired VM', async () => {
  const body = await fetch(`${BASE}/vms`).then(r => r.json());
  assertEqual(body.total, 1, 'total=1');
  assertEqual(body.vms[0].vmId, vmId, 'vmId matches');
  assert(typeof body.vms[0].ageMs === 'number', 'has ageMs');
});

await test('POST /vms/:id/run executes command', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo hello' }),
  });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.stdout, 'hello', 'stdout');
  assertEqual(body.code, 0, 'exit code 0');
});

await test('POST /vms/:id/run returns error on bad command', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'exit 1' }),
  });
  assertEqual(res.status, 200, 'status 200 (result, not error)');
  const body = await res.json();
  assertEqual(body.code, 1, 'exit code 1');
});

await test('POST /vms/:id/run 400 if no command', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assertEqual(res.status, 400, 'status 400');
});

await test('POST /vms/:id/run 404 on unknown vmId', async () => {
  const res = await fetch(`${BASE}/vms/doesnotexist/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo hi' }),
  });
  assertEqual(res.status, 404, 'status 404');
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────
console.log('\nPipeline');

await test('POST /vms/:id/pipeline runs multiple commands', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: ['echo step1', 'echo step2', 'echo step3'] }),
  });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.results.length, 3, '3 results');
  assertEqual(body.stopped, false, 'not stopped');
  assertEqual(body.results[0].stdout, 'step1', 'step1 output');
  assertEqual(body.results[2].stdout, 'step3', 'step3 output');
});

await test('POST /vms/:id/pipeline stops on error when stopOnError=true', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: ['echo ok', 'exit 1', 'echo should-not-run'],
      stopOnError: true,
    }),
  });
  const body = await res.json();
  assertEqual(body.stopped, true, 'stopped at error');
  assertEqual(body.results.length, 2, 'only 2 results (stopped at exit 1)');
});

await test('POST /vms/:id/pipeline 400 if commands missing', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [] }),
  });
  assertEqual(res.status, 400, 'status 400');
});

// ─── Release ──────────────────────────────────────────────────────────────────
console.log('\nRelease');

await test('POST /vms/:id/release destroys VM', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/release`, { method: 'POST' });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.vmId, vmId, 'vmId in response');
  assert(typeof body.ageMs === 'number', 'has ageMs');
});

await test('activeVMs decrements after release', async () => {
  const health = await fetch(`${BASE}/health`).then(r => r.json());
  assertEqual(health.activeVMs, 0, 'back to 0');
});

await test('released VM is gone from /vms', async () => {
  const body = await fetch(`${BASE}/vms`).then(r => r.json());
  assertEqual(body.total, 0, 'total=0');
});

await test('POST /vms/:id/release 404 on already-released VM', async () => {
  const res = await fetch(`${BASE}/vms/${vmId}/release`, { method: 'POST' });
  assertEqual(res.status, 404, 'status 404');
});

// ─── Pool Resize ──────────────────────────────────────────────────────────────
console.log('\nPool Resize');

await test('POST /pool/resize changes pool target size', async () => {
  const res = await fetch(`${BASE}/pool/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: 4 }),
  });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.newSize, 4, 'newSize=4');
});

await test('POST /pool/resize 400 on invalid size', async () => {
  const res = await fetch(`${BASE}/pool/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: 99 }),
  });
  assertEqual(res.status, 400, 'status 400');
});

// ─── Metrics after operations ─────────────────────────────────────────────────
console.log('\nMetrics after operations');

await test('Metrics counters reflect operations', async () => {
  const text = await fetch(`${BASE}/metrics`).then(r => r.text());
  const acquireMatch = text.match(/^carapace_acquire_total (\d+)/m);
  const runMatch = text.match(/^carapace_run_total (\d+)/m);
  assert(acquireMatch, 'acquire counter found');
  assert(runMatch, 'run counter found');
  assert(parseInt(acquireMatch[1]) >= 1, 'at least 1 acquire');
  assert(parseInt(runMatch[1]) >= 2, 'at least 2 runs');
});

// ─── Results ─────────────────────────────────────────────────────────────────

await server.stop();

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (errors.length > 0) {
  console.log('\nFailures:');
  for (const { name, error } of errors) {
    console.log(`  ❌ ${name}: ${error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
