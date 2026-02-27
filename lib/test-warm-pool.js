#!/usr/bin/env node
/**
 * WarmPool Unit Tests (no real VM required)
 *
 * Tests pool logic with a mock CarapaceRunner that simulates boot latency.
 * Run: node lib/test-warm-pool.js
 */

import { WarmPool } from './warm-pool.js';

// ─── Mock runner factory ──────────────────────────────────────────────────────

let _mockIdCounter = 0;

function makeMockRunner({ bootDelayMs = 100, bootShouldFail = false } = {}) {
  const id = ++_mockIdCounter;
  return {
    _mockId: id,
    _bootDelayMs: bootDelayMs,
    _bootShouldFail: bootShouldFail,
    _booted: false,
    _shutdown: false,
    _runCount: 0,
    async boot() {
      await delay(this._bootDelayMs);
      if (this._bootShouldFail) throw new Error(`Mock boot failure (id=${id})`);
      this._booted = true;
    },
    async run(cmd) {
      if (!this._booted) throw new Error('Not booted');
      this._runCount++;
      await delay(5);
      return { stdout: `mock:${cmd}`, stderr: '', code: 0, duration: 5 };
    },
    async shutdown() {
      this._shutdown = true;
      this._booted = false;
    },
    get info() { return { booted: this._booted, sshPort: 12200 + id }; },
  };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Patch helper — must be called BEFORE pool.start() ───────────────────────
// Replaces the private _bootSlot implementation with one using mock runners.

function patchPool(pool, runnerOpts = {}) {
  // Override _bootSlot to use mock runners instead of real QEMU
  pool._bootSlot = async function () {
    const slotId = `slot-${++this._slotCounter}`;
    const slot = _makeSlot(slotId);
    this._slots.set(slotId, slot);
    this.emit('slot:booting', { slotId });
    this._log(`Booting mock slot ${slotId}...`);

    const runner = makeMockRunner(runnerOpts);
    slot.runner = runner;

    try {
      await runner.boot();
      if (this._stopping) {
        await runner.shutdown().catch(() => {});
        slot.state = 'dead';
        this._slots.delete(slotId);
        return;
      }
      slot.state = 'warm';
      slot.warmAt = Date.now();
      this._log(`Slot ${slotId} warm`);
      this.emit('slot:warm', { slotId, bootMs: slot.age });
      this._serveWaiters();
    } catch (err) {
      this._log(`Slot ${slotId} failed: ${err.message}`);
      slot.state = 'dead';
      slot.error = err.message;
      this._slots.delete(slotId);
      this.emit('slot:error', { slotId, error: err.message });
      if (!this._stopping) setTimeout(() => this._refill(), 100);
    }
  };

  return pool;
}

function _makeSlot(id) {
  return {
    id,
    state: 'booting',
    runner: null,
    createdAt: Date.now(),
    warmAt: null,
    acquiredAt: null,
    error: null,
    get age() { return Date.now() - this.createdAt; },
    get warmAge() { return this.warmAt ? Date.now() - this.warmAt : null; },
  };
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('🦞 WarmPool Unit Tests');
console.log('======================\n');

// 1. Basic construction
await test('Creates with default options', async () => {
  const pool = new WarmPool({ image: './fake.qcow2' });
  assert(pool.targetSize === 2);
  assert(pool.maxSize === 8);
  assert(!pool._started);
});

// 2. Pool starts and VMs warm
await test('start() boots target VMs', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 2, verbose: false }));
  await pool.start();
  await delay(50); // let the second boot complete
  const s = pool.stats();
  assert(s.warm >= 1, `warm=${s.warm}, expected >=1`);
  await pool.stop();
});

// 3. Acquire returns runner instantly
await test('acquire() is instant when warm VM is ready', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }));
  await pool.start(); // waits for first warm VM
  const t0 = Date.now();
  const runner = await pool.acquire();
  const ms = Date.now() - t0;
  assert(ms < 50, `expected <50ms, got ${ms}ms`);
  assert(typeof runner.run === 'function');
  await pool.release(runner);
  await pool.stop();
});

// 4. Acquired VM moves from warm to active
await test('acquire() moves slot from warm→active', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 2, verbose: false }));
  await pool.start();
  await delay(50);
  const s1 = pool.stats();
  const runner = await pool.acquire();
  const s2 = pool.stats();
  assert(s2.active === 1, `active=${s2.active}`);
  assert(s2.warm < s1.warm + s1.booting, 'warm should decrease');
  await pool.release(runner);
  await pool.stop();
});

// 5. Released VM is destroyed (not recycled)
await test('release() destroys the VM (shutdown called)', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }));
  await pool.start();
  const runner = await pool.acquire();
  await pool.release(runner);
  assert(runner._shutdown, 'runner.shutdown() should have been called');
  await pool.stop();
});

// 6. Release triggers refill
await test('release() triggers pool refill', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 2, verbose: false }));
  await pool.start();
  const runner = await pool.acquire();
  await pool.release(runner);
  await delay(300); // let refill complete
  const s = pool.stats();
  assert(s.warm + s.booting >= 1, 'pool should be refilling');
  await pool.stop();
});

// 7. Multiple concurrent acquires get unique VMs
await test('Concurrent acquires get unique VMs', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 3, verbose: false }));
  await pool.start();
  await delay(300); // ensure 3 VMs warm

  const runners = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  const ids = new Set(runners.map(r => r._mockId));
  assert(ids.size === 3, `expected 3 unique runners, got ${ids.size}`);

  await Promise.all(runners.map(r => pool.release(r)));
  await pool.stop();
});

// 8. acquire() waits when pool empty
await test('acquire() blocks and resolves when VM warms', async () => {
  const pool = patchPool(
    new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }),
    { bootDelayMs: 150 }
  );
  await pool.start(); // waits for first warm
  const first = await pool.acquire(); // drain the pool
  
  const t0 = Date.now();
  const waitPromise = pool.acquire({ timeoutMs: 3000 });
  await pool.release(first); // trigger refill
  const second = await waitPromise;
  const ms = Date.now() - t0;

  assert(second !== null);
  assert(ms < 2000, `expected <2000ms, got ${ms}ms`);
  await pool.release(second);
  await pool.stop();
});

// 9. Acquire timeout
await test('acquire() rejects after timeoutMs', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }));
  pool._started = true; // skip start() so pool stays empty

  try {
    await pool.acquire({ timeoutMs: 100 });
    assert(false, 'should have rejected');
  } catch (err) {
    assert(err.message.includes('timed out'), `got: ${err.message}`);
  }
  // cleanup
  pool._started = false;
});

// 10. stop() rejects waiters
await test('stop() rejects pending acquire() waiters', async () => {
  const pool = patchPool(
    new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }),
    { bootDelayMs: 1000 } // slow boot so pool stays empty longer
  );
  pool._started = true;
  pool._stopping = false;

  const acquirePromise = pool.acquire({ timeoutMs: 5000 });
  // Give it a moment to register the waiter
  await delay(10);
  await pool.stop();

  try {
    await acquirePromise;
    assert(false, 'should have been rejected');
  } catch (err) {
    assert(err.message.includes('stopped') || err.message.includes('timed'),
           `got: ${err.message}`);
  }
});

// 11. stats() accounting
await test('stats() warm + booting + active === total', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 2, verbose: false }));
  await pool.start();
  await delay(50);

  const s = pool.stats();
  assert(
    s.warm + s.booting + s.active === s.total,
    `${s.warm}+${s.booting}+${s.active} !== ${s.total}`
  );
  await pool.stop();
});

// 12. statusLine format
await test('statusLine() includes warm/booting/active', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }));
  await pool.start();
  const line = pool.statusLine();
  assert(line.includes('warm='));
  assert(line.includes('booting='));
  assert(line.includes('active='));
  await pool.stop();
});

// 13. VM can actually run commands
await test('Acquired VM runs commands correctly', async () => {
  const pool = patchPool(new WarmPool({ image: './fake.qcow2', size: 1, verbose: false }));
  await pool.start();
  const runner = await pool.acquire();
  const result = await runner.run('node --version');
  assert(result.code === 0);
  assert(result.stdout.includes('mock:node'));
  await pool.release(runner);
  await pool.stop();
});

// 14. maxWarmAgeMs evicts stale VMs
await test('maxWarmAgeMs evicts stale warm VMs', async () => {
  const pool = patchPool(new WarmPool({ 
    image: './fake.qcow2', 
    size: 1, 
    verbose: false,
    maxWarmAgeMs: 100 // VMs expire after 100ms
  }));
  await pool.start();

  // Wait for VM to go stale
  await delay(200);

  // Next acquire should trigger eviction + refill path
  // (may block briefly while refilling)
  const runner = await pool.acquire({ timeoutMs: 2000 });
  assert(runner !== null);
  await pool.release(runner);
  await pool.stop();
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
}
