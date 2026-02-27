#!/usr/bin/env node
/**
 * CarapaceOS Warm Pool
 *
 * Eliminates the ~25s boot penalty by pre-booting VMs and keeping them
 * ready to use. When an agent needs a VM, it gets one immediately instead
 * of waiting for boot.
 *
 * Design:
 * - Pool maintains N "warm" VMs (pre-booted, clean state, idle)
 * - Acquisition atomically removes a VM from warm pool → active
 * - After release, VM is DESTROYED (not recycled) — isolation guarantee
 * - Pool automatically refills in the background after each acquisition
 * - Configurable min/max pool size with backpressure
 *
 * @example
 * import { WarmPool } from './lib/warm-pool.js';
 *
 * const pool = new WarmPool({ image: './carapaceos.qcow2', size: 3 });
 * await pool.start();
 *
 * // Instantly acquire a pre-booted VM (no 25s wait!)
 * const vm = await pool.acquire();
 * const result = await vm.run('node --version');
 * await pool.release(vm); // destroys VM, refills pool
 *
 * await pool.stop(); // graceful shutdown
 */

import { CarapaceRunner } from './agent-runner.js';
import { EventEmitter } from 'events';

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_MAX_ACQUIRE_WAIT = 120_000; // 2 min max wait if pool is empty
const DEFAULT_MAX_SIZE = 8;               // hard cap on concurrent VMs

/**
 * Pool states for each slot
 */
const SlotState = {
  BOOTING: 'booting',   // VM is starting up
  WARM: 'warm',          // VM ready, waiting in pool
  ACTIVE: 'active',      // VM checked out to a caller
  DEAD: 'dead',          // VM shutdown (terminal)
};

/**
 * A single pool slot — tracks one VM's lifecycle
 */
class PoolSlot {
  constructor(id) {
    this.id = id;
    this.state = SlotState.BOOTING;
    this.runner = null;
    this.createdAt = Date.now();
    this.warmAt = null;
    this.acquiredAt = null;
    this.error = null;
  }

  get age() { return Date.now() - this.createdAt; }
  get warmAge() { return this.warmAt ? Date.now() - this.warmAt : null; }
}

/**
 * WarmPool — pre-boots CarapaceOS VMs for instant acquisition
 */
export class WarmPool extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.image - Path to the base qcow2 image (required)
   * @param {number} [opts.size=2] - Target number of warm VMs to maintain
   * @param {number} [opts.maxSize=8] - Hard cap on total concurrent VMs
   * @param {string} [opts.memory='512'] - Memory per VM in MB
   * @param {number} [opts.maxAcquireWaitMs=120000] - Max wait if pool is empty
   * @param {number} [opts.maxWarmAgeMs] - Max age for a warm VM (refreshed if stale)
   * @param {boolean} [opts.verbose=false] - Log activity to stderr
   */
  constructor(opts = {}) {
    super();

    if (!opts.image) throw new Error('WarmPool: opts.image is required');

    this.image = opts.image;
    this.targetSize = Math.max(1, opts.size ?? DEFAULT_POOL_SIZE);
    this.maxSize = Math.max(this.targetSize, opts.maxSize ?? DEFAULT_MAX_SIZE);
    this.memory = opts.memory ?? '512';
    this.maxAcquireWaitMs = opts.maxAcquireWaitMs ?? DEFAULT_MAX_ACQUIRE_WAIT;
    this.maxWarmAgeMs = opts.maxWarmAgeMs ?? null; // null = no age limit
    this.verbose = opts.verbose ?? false;

    /** @type {Map<string, PoolSlot>} */
    this._slots = new Map();
    this._slotCounter = 0;
    this._started = false;
    this._stopping = false;

    // Waiters: callers blocked on acquire() when pool is empty
    this._waiters = [];

    // Refill debounce — avoid hammering boot if many acquisitions happen at once
    this._refillTimer = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the pool — begins pre-booting VMs.
   * Returns when at least one warm VM is available (or throws if all fail).
   */
  async start() {
    if (this._started) return this;
    this._started = true;
    this._stopping = false;

    this._log(`Starting pool (target=${this.targetSize}, max=${this.maxSize})`);

    // Kick off initial fill immediately (no delay on first fill)
    await this._refill();

    // Wait until we have at least one warm VM or all boot attempts fail
    await this._waitForFirstWarm();

    return this;
  }

  /**
   * Stop the pool gracefully — shuts down all VMs (warm + active).
   */
  async stop() {
    if (this._stopping) return;
    this._stopping = true;

    this._log('Stopping pool...');
    clearTimeout(this._refillTimer);

    // Reject all pending waiters
    for (const waiter of this._waiters) {
      waiter.reject(new Error('WarmPool stopped'));
    }
    this._waiters = [];

    // Shut down all VMs
    const shutdownPromises = [];
    for (const slot of this._slots.values()) {
      if (slot.runner && slot.state !== SlotState.DEAD) {
        shutdownPromises.push(
          slot.runner.shutdown().catch(err => {
            this._log(`Shutdown error for slot ${slot.id}: ${err.message}`);
          })
        );
        slot.state = SlotState.DEAD;
      }
    }

    await Promise.allSettled(shutdownPromises);
    this._slots.clear();
    this._started = false;
    this._log('Pool stopped');
    this.emit('stopped');
  }

  // ─── Acquire / Release ──────────────────────────────────────────────────────

  /**
   * Acquire a pre-booted VM from the pool.
   * Returns immediately if a warm VM is available; otherwise waits up to maxAcquireWaitMs.
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Override max wait time for this call
   * @returns {CarapaceRunner} A booted, ready-to-use runner
   */
  async acquire(opts = {}) {
    if (!this._started) throw new Error('WarmPool not started. Call pool.start() first.');
    if (this._stopping) throw new Error('WarmPool is stopping');

    const timeoutMs = opts.timeoutMs ?? this.maxAcquireWaitMs;

    // Try to grab a warm slot immediately
    const warmSlot = this._findWarmSlot();
    if (warmSlot) {
      return this._checkout(warmSlot);
    }

    // No warm VMs available — wait for one to become ready
    this._log(`No warm VMs available, waiting (timeout=${timeoutMs}ms)...`);
    this.emit('pool:empty');

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this._waiters.push(waiter);

      const timer = setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(new Error(`WarmPool.acquire() timed out after ${timeoutMs}ms — no warm VM became available`));
      }, timeoutMs);

      // Clean up timer when resolved
      const origResolve = waiter.resolve;
      waiter.resolve = (val) => { clearTimeout(timer); origResolve(val); };
      const origReject = waiter.reject;
      waiter.reject = (err) => { clearTimeout(timer); origReject(err); };
    });
  }

  /**
   * Release a VM back — DESTROYS it (no recycling) and triggers pool refill.
   *
   * @param {CarapaceRunner} runner - Runner returned from acquire()
   */
  async release(runner) {
    const slot = this._findSlotByRunner(runner);
    if (!slot) {
      // Unknown runner — just shut it down
      this._log('release(): unknown runner, shutting down');
      await runner.shutdown().catch(() => {});
      return;
    }

    this._log(`Releasing slot ${slot.id} → destroying VM`);
    slot.state = SlotState.DEAD;

    // Destroy the VM (don't await — let it happen in background)
    runner.shutdown().catch(err => {
      this._log(`Shutdown error for slot ${slot.id}: ${err.message}`);
    });

    this._slots.delete(slot.id);
    this.emit('pool:released', { slotId: slot.id });

    // Refill the pool
    this._scheduleRefill();
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Get current pool statistics.
   * @returns {{ warm: number, booting: number, active: number, total: number, waiters: number }}
   */
  stats() {
    const slots = Array.from(this._slots.values());
    return {
      warm: slots.filter(s => s.state === SlotState.WARM).length,
      booting: slots.filter(s => s.state === SlotState.BOOTING).length,
      active: slots.filter(s => s.state === SlotState.ACTIVE).length,
      total: slots.filter(s => s.state !== SlotState.DEAD).length,
      waiters: this._waiters.length,
      targetSize: this.targetSize,
      maxSize: this.maxSize,
    };
  }

  /**
   * Human-readable pool status string.
   */
  statusLine() {
    const s = this.stats();
    return `[WarmPool] warm=${s.warm} booting=${s.booting} active=${s.active} waiters=${s.waiters}`;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _log(msg) {
    if (this.verbose) {
      process.stderr.write(`[WarmPool] ${msg}\n`);
    }
    this.emit('log', msg);
  }

  _findWarmSlot() {
    // Find oldest warm slot (FIFO — first-in gets used first to avoid stale VMs)
    let oldest = null;
    for (const slot of this._slots.values()) {
      if (slot.state !== SlotState.WARM) continue;
      // Check age if maxWarmAgeMs is set
      if (this.maxWarmAgeMs && slot.warmAge > this.maxWarmAgeMs) {
        this._log(`Slot ${slot.id} is stale (${slot.warmAge}ms), discarding`);
        this._evictStale(slot);
        continue;
      }
      if (!oldest || slot.warmAt < oldest.warmAt) {
        oldest = slot;
      }
    }
    return oldest;
  }

  _evictStale(slot) {
    slot.state = SlotState.DEAD;
    if (slot.runner) {
      slot.runner.shutdown().catch(() => {});
    }
    this._slots.delete(slot.id);
    this._scheduleRefill();
  }

  _findSlotByRunner(runner) {
    for (const slot of this._slots.values()) {
      if (slot.runner === runner) return slot;
    }
    return null;
  }

  _checkout(slot) {
    slot.state = SlotState.ACTIVE;
    slot.acquiredAt = Date.now();
    const warmAge = slot.warmAge;
    this._log(`Acquired slot ${slot.id} (was warm for ${warmAge}ms)`);
    this.emit('pool:acquired', { slotId: slot.id, warmAgeMs: warmAge });

    // Refill in background
    this._scheduleRefill();

    return slot.runner;
  }

  _scheduleRefill(delayMs = 50) {
    if (this._stopping) return;
    clearTimeout(this._refillTimer);
    this._refillTimer = setTimeout(() => this._refill(), delayMs);
  }

  async _refill() {
    if (this._stopping) return;

    const s = this.stats();
    const needed = this.targetSize - s.warm - s.booting;
    const canBoot = this.maxSize - s.total;
    const toStart = Math.min(needed, canBoot);

    if (toStart <= 0) return;

    this._log(`Refilling pool: starting ${toStart} VM(s) (needed=${needed}, canBoot=${canBoot})`);

    // Start VMs in parallel
    const boots = [];
    for (let i = 0; i < toStart; i++) {
      boots.push(this._bootSlot());
    }

    // Don't await — let them run in background
    Promise.allSettled(boots);
  }

  async _bootSlot() {
    const slotId = `slot-${++this._slotCounter}`;
    const slot = new PoolSlot(slotId);
    this._slots.set(slotId, slot);
    this.emit('slot:booting', { slotId });

    this._log(`Booting slot ${slotId}...`);
    const bootStart = Date.now();

    const runner = new CarapaceRunner({
      image: this.image,
      memory: this.memory,
      verbose: false,
    });
    slot.runner = runner;

    try {
      await runner.boot();
      const bootMs = Date.now() - bootStart;

      if (this._stopping) {
        // Shutting down — don't warm this VM
        await runner.shutdown().catch(() => {});
        slot.state = SlotState.DEAD;
        this._slots.delete(slotId);
        return;
      }

      slot.state = SlotState.WARM;
      slot.warmAt = Date.now();
      this._log(`Slot ${slotId} warm (boot took ${bootMs}ms)`);
      this.emit('slot:warm', { slotId, bootMs });

      // Serve any waiting callers
      this._serveWaiters();

    } catch (err) {
      this._log(`Slot ${slotId} boot failed: ${err.message}`);
      slot.state = SlotState.DEAD;
      slot.error = err.message;
      this._slots.delete(slotId);
      this.emit('slot:error', { slotId, error: err.message });

      // Retry after a delay
      if (!this._stopping) {
        setTimeout(() => this._refill(), 5000);
      }
    }
  }

  _serveWaiters() {
    while (this._waiters.length > 0) {
      const warmSlot = this._findWarmSlot();
      if (!warmSlot) break;

      const waiter = this._waiters.shift();
      const runner = this._checkout(warmSlot);
      waiter.resolve(runner);
    }
  }

  async _waitForFirstWarm() {
    return new Promise((resolve, reject) => {
      // Check if already warm
      if (this._findWarmSlot()) {
        resolve();
        return;
      }

      // Check if any slots are booting
      const s = this.stats();
      if (s.booting === 0) {
        reject(new Error('WarmPool: no VMs booting and pool is empty'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('WarmPool: timed out waiting for first warm VM'));
      }, 300_000); // 5 min max

      const onWarm = () => {
        clearTimeout(timeout);
        this.off('slot:warm', onWarm);
        this.off('slot:error', onError);
        resolve();
      };

      const onError = () => {
        // Check if anything is still booting
        const s = this.stats();
        if (s.booting === 0 && s.warm === 0) {
          clearTimeout(timeout);
          this.off('slot:warm', onWarm);
          this.off('slot:error', onError);
          reject(new Error('WarmPool: all boot attempts failed'));
        }
      };

      this.on('slot:warm', onWarm);
      this.on('slot:error', onError);
    });
  }
}

/**
 * Global singleton pool per process.
 * Use this if you want a shared pool without managing lifecycle manually.
 *
 * @param {object} opts - WarmPool constructor options
 * @returns {WarmPool}
 */
let _globalPool = null;

export function getGlobalPool(opts = {}) {
  if (!_globalPool) {
    _globalPool = new WarmPool(opts);
  }
  return _globalPool;
}

export async function stopGlobalPool() {
  if (_globalPool) {
    await _globalPool.stop();
    _globalPool = null;
  }
}
