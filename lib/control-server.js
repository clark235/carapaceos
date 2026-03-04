#!/usr/bin/env node
/**
 * CarapaceOS Control Server
 *
 * A lightweight HTTP REST API for managing CarapaceOS VMs programmatically.
 * Exposes WarmPool and CarapaceRunner over HTTP so any agent (local or remote)
 * can request isolated VM environments without needing Node.js bindings.
 *
 * Designed to run as a local daemon on the host machine. Not intended for
 * public exposure — use a reverse proxy with auth if you need remote access.
 *
 * ## API
 *
 * POST /vms/acquire                    — Acquire a warm VM (returns vmId + connection info)
 * POST /vms/:id/run                    — Run a command in a VM (body: { command, timeoutMs? })
 * POST /vms/:id/pipeline               — Run multiple commands in sequence
 * POST /vms/:id/upload                 — Upload a file into the VM (body: { content, path, encoding? })
 * GET  /vms/:id/download?path=         — Download a file from the VM (returns base64 content)
 * POST /vms/:id/snapshots              — Save a VM snapshot/checkpoint (body: { name })
 * GET  /vms/:id/snapshots              — List all snapshots for a VM
 * POST /vms/:id/snapshots/:snap/restore — Restore a VM to a named snapshot
 * DELETE /vms/:id/snapshots/:snap      — Delete a named snapshot
 * POST /vms/:id/release                — Release (destroy) a VM
 * GET  /vms                            — List active VMs
 * GET  /pool/status                    — Pool health stats
 * POST /pool/resize                    — Resize the warm pool (body: { size })
 * GET  /health                         — Health check
 * GET  /metrics                        — Prometheus-style metrics (text/plain)
 *
 * ## Usage
 *
 *   import { ControlServer } from './lib/control-server.js';
 *
 *   const server = new ControlServer({
 *     image: './vm-image/carapaceos.qcow2',
 *     port: 7375,
 *     poolSize: 2,
 *   });
 *   await server.start();
 *   // server listening on http://127.0.0.1:7375
 *
 *   // Later:
 *   await server.stop();
 *
 * ## HTTP Client Example
 *
 *   // Acquire a VM
 *   const { vmId } = await fetch('http://127.0.0.1:7375/vms/acquire', { method: 'POST' }).then(r => r.json());
 *
 *   // Run a command
 *   const result = await fetch(`http://127.0.0.1:7375/vms/${vmId}/run`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ command: 'node --version' }),
 *   }).then(r => r.json());
 *   // → { stdout: 'v22.15.1', stderr: '', code: 0, duration: 155 }
 *
 *   // Release
 *   await fetch(`http://127.0.0.1:7375/vms/${vmId}/release`, { method: 'POST' });
 */

import { createServer } from 'http';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WarmPool } from './warm-pool.js';
import { CarapaceRunner } from './agent-runner.js';

const DEFAULT_PORT = 7375;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_POOL_SIZE = 2;
const MAX_BODY_BYTES = 1024 * 1024;      // 1MB for JSON bodies
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64MB for file uploads

// ─── Utilities ───────────────────────────────────────────────────────────────

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function parseBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Powered-By': 'CarapaceOS',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function err(res, status, message) {
  send(res, status, { error: message });
}

// ─── Request Router ───────────────────────────────────────────────────────────

function route(method, pattern) {
  // Returns a match function: (reqMethod, reqPath) → params | null
  const paramNames = [];
  const regexStr = pattern.replace(/:([a-z]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp(`^${regexStr}$`);

  return (reqMethod, reqPath) => {
    if (reqMethod !== method) return null;
    const m = reqPath.match(regex);
    if (!m) return null;
    const params = {};
    paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
    return params;
  };
}

// ─── ControlServer ────────────────────────────────────────────────────────────

export class ControlServer {
  /**
   * @param {object} opts
   * @param {string} opts.image           - Path to carapaceos.qcow2
   * @param {number} [opts.port=7375]     - HTTP port to listen on
   * @param {string} [opts.host]          - Bind host (default 127.0.0.1)
   * @param {number} [opts.poolSize=2]    - Number of warm VMs to pre-boot
   * @param {number} [opts.vmMemory=512]  - RAM per VM in MB
   * @param {string} [opts.networkMode='nat'] - VM network mode: nat|isolated|allowlist|none
   * @param {Array}  [opts.networkAllow=[]]   - Allowlist entries: [{ host, port }]
   * @param {string} [opts.dnsServer]         - DNS server override for allowlist mode
   * @param {boolean} [opts.verbose=false] - Verbose logging
   */
  constructor(opts = {}) {
    this.image = opts.image;
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? DEFAULT_HOST;
    this.poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
    this.vmMemory = String(opts.vmMemory ?? 512);
    this.networkMode = opts.networkMode ?? 'nat';
    this.networkAllow = opts.networkAllow ?? [];
    this.dnsServer = opts.dnsServer ?? null;
    this.verbose = opts.verbose ?? false;

    /** @type {Map<string, { vm: CarapaceRunner, acquiredAt: number, meta: object }>} */
    this.activeVMs = new Map();

    /** @type {WarmPool|null} */
    this.pool = null;

    /** @type {import('http').Server|null} */
    this.server = null;

    // Metrics counters
    this._metrics = {
      acquireTotal: 0,
      releaseTotal: 0,
      runTotal: 0,
      runErrors: 0,
      acquireErrors: 0,
      uploadTotal: 0,
      downloadTotal: 0,
      transferErrors: 0,
      snapshotTotal: 0,
      restoreTotal: 0,
      snapshotErrors: 0,
      startTime: Date.now(),
    };

    // Route table
    this._routes = [
      [route('GET',  '/health'),            this._handleHealth.bind(this)],
      [route('GET',  '/metrics'),           this._handleMetrics.bind(this)],
      [route('GET',  '/vms'),               this._handleListVMs.bind(this)],
      [route('POST', '/vms/acquire'),       this._handleAcquire.bind(this)],
      [route('POST', '/vms/:id/run'),       this._handleRun.bind(this)],
      [route('POST', '/vms/:id/pipeline'),  this._handlePipeline.bind(this)],
      [route('POST',   '/vms/:id/upload'),                     this._handleUpload.bind(this)],
      [route('GET',    '/vms/:id/download'),                   this._handleDownload.bind(this)],
      [route('POST',   '/vms/:id/snapshots'),                  this._handleSnapshotSave.bind(this)],
      [route('GET',    '/vms/:id/snapshots'),                  this._handleSnapshotList.bind(this)],
      [route('POST',   '/vms/:id/snapshots/:snap/restore'),    this._handleSnapshotRestore.bind(this)],
      [route('DELETE', '/vms/:id/snapshots/:snap'),            this._handleSnapshotDelete.bind(this)],
      [route('POST',   '/vms/:id/release'),                    this._handleRelease.bind(this)],
      [route('GET',  '/pool/status'),       this._handlePoolStatus.bind(this)],
      [route('POST', '/pool/resize'),       this._handlePoolResize.bind(this)],
    ];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    if (!this.image) throw new Error('ControlServer: opts.image is required');

    // Start warm pool
    this.pool = new WarmPool({
      image: this.image,
      size: this.poolSize,
      memory: this.vmMemory,
      verbose: this.verbose,
      networkMode: this.networkMode,
      networkAllow: this.networkAllow,
      dnsServer: this.dnsServer,
    });

    if (this.verbose) console.log(`[ControlServer] Starting warm pool (size=${this.poolSize})...`);
    await this.pool.start();

    // Start HTTP server
    this.server = createServer((req, res) => this._dispatch(req, res));
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    console.log(`[ControlServer] Listening on http://${this.host}:${this.port}`);
    return this;
  }

  async stop() {
    if (this.verbose) console.log('[ControlServer] Shutting down...');

    // Release all active VMs
    const shutdowns = [...this.activeVMs.values()].map(({ vm }) =>
      vm.shutdown().catch(e => console.error('[ControlServer] VM shutdown error:', e))
    );
    await Promise.all(shutdowns);
    this.activeVMs.clear();

    // Stop pool
    if (this.pool) {
      await this.pool.stop().catch(e => console.error('[ControlServer] Pool stop error:', e));
    }

    // Close HTTP server
    if (this.server) {
      await new Promise((resolve, reject) =>
        this.server.close(err => err ? reject(err) : resolve())
      );
    }

    console.log('[ControlServer] Stopped.');
  }

  // ─── Dispatcher ─────────────────────────────────────────────────────────────

  async _dispatch(req, res) {
    const method = req.method;
    const url = new URL(req.url, `http://${this.host}`);
    const path = url.pathname;

    if (this.verbose) console.log(`[ControlServer] ${method} ${path}`);

    for (const [matcher, handler] of this._routes) {
      const params = matcher(method, path);
      if (params !== null) {
        try {
          await handler(req, res, params);
        } catch (e) {
          console.error(`[ControlServer] Handler error for ${method} ${path}:`, e.message);
          err(res, 500, e.message || 'Internal error');
        }
        return;
      }
    }

    err(res, 404, `Not found: ${method} ${path}`);
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async _handleHealth(req, res) {
    const poolStats = this.pool ? this.pool.stats() : null;
    send(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - this._metrics.startTime) / 1000),
      pool: poolStats,
      activeVMs: this.activeVMs.size,
      network: {
        mode: this.networkMode,
        allowlist: this.networkAllow.length > 0
          ? this.networkAllow.map(e => `${e.host}:${e.port}`)
          : undefined,
        dns: this.dnsServer || undefined,
      },
    });
  }

  async _handleMetrics(req, res) {
    const m = this._metrics;
    const poolStats = this.pool ? this.pool.stats() : {};
    const uptime = Math.floor((Date.now() - m.startTime) / 1000);

    const lines = [
      '# HELP carapace_acquire_total Total VM acquisitions',
      '# TYPE carapace_acquire_total counter',
      `carapace_acquire_total ${m.acquireTotal}`,
      '',
      '# HELP carapace_release_total Total VM releases',
      '# TYPE carapace_release_total counter',
      `carapace_release_total ${m.releaseTotal}`,
      '',
      '# HELP carapace_run_total Total commands executed',
      '# TYPE carapace_run_total counter',
      `carapace_run_total ${m.runTotal}`,
      '',
      '# HELP carapace_run_errors_total Total command errors',
      '# TYPE carapace_run_errors_total counter',
      `carapace_run_errors_total ${m.runErrors}`,
      '',
      '# HELP carapace_acquire_errors_total Total acquire errors',
      '# TYPE carapace_acquire_errors_total counter',
      `carapace_acquire_errors_total ${m.acquireErrors}`,
      '',
      '# HELP carapace_active_vms Currently active (checked out) VMs',
      '# TYPE carapace_active_vms gauge',
      `carapace_active_vms ${this.activeVMs.size}`,
      '',
      '# HELP carapace_pool_warm Warm VMs in pool',
      '# TYPE carapace_pool_warm gauge',
      `carapace_pool_warm ${poolStats.warm ?? 0}`,
      '',
      '# HELP carapace_pool_booting VMs currently booting',
      '# TYPE carapace_pool_booting gauge',
      `carapace_pool_booting ${poolStats.booting ?? 0}`,
      '',
      '# HELP carapace_upload_total Total file uploads to VMs',
      '# TYPE carapace_upload_total counter',
      `carapace_upload_total ${m.uploadTotal}`,
      '',
      '# HELP carapace_download_total Total file downloads from VMs',
      '# TYPE carapace_download_total counter',
      `carapace_download_total ${m.downloadTotal}`,
      '',
      '# HELP carapace_transfer_errors_total Total file transfer errors',
      '# TYPE carapace_transfer_errors_total counter',
      `carapace_transfer_errors_total ${m.transferErrors}`,
      '',
      '# HELP carapace_snapshot_total Total VM snapshots saved',
      '# TYPE carapace_snapshot_total counter',
      `carapace_snapshot_total ${m.snapshotTotal}`,
      '',
      '# HELP carapace_restore_total Total VM snapshot restores',
      '# TYPE carapace_restore_total counter',
      `carapace_restore_total ${m.restoreTotal}`,
      '',
      '# HELP carapace_snapshot_errors_total Total snapshot/restore errors',
      '# TYPE carapace_snapshot_errors_total counter',
      `carapace_snapshot_errors_total ${m.snapshotErrors}`,
      '',
      '# HELP carapace_uptime_seconds Server uptime in seconds',
      '# TYPE carapace_uptime_seconds gauge',
      `carapace_uptime_seconds ${uptime}`,
      '',
    ];

    sendText(res, 200, lines.join('\n'));
  }

  async _handleListVMs(req, res) {
    const vms = [...this.activeVMs.entries()].map(([id, { acquiredAt, meta }]) => ({
      vmId: id,
      acquiredAt: new Date(acquiredAt).toISOString(),
      ageMs: Date.now() - acquiredAt,
      meta,
    }));
    send(res, 200, { vms, total: vms.length });
  }

  async _handleAcquire(req, res) {
    let body = {};
    try {
      body = await parseBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }

    const timeoutMs = body.timeoutMs ?? 120_000;
    const meta = body.meta ?? {};

    try {
      const vm = await this.pool.acquire({ timeoutMs });
      const vmId = randomId();
      this.activeVMs.set(vmId, { vm, acquiredAt: Date.now(), meta });
      this._metrics.acquireTotal++;

      send(res, 200, {
        vmId,
        message: 'VM acquired — ready for commands',
        acquiredAt: new Date().toISOString(),
        endpoints: {
          run: `/vms/${vmId}/run`,
          pipeline: `/vms/${vmId}/pipeline`,
          release: `/vms/${vmId}/release`,
        },
      });
    } catch (e) {
      this._metrics.acquireErrors++;
      err(res, 503, `Failed to acquire VM: ${e.message}`);
    }
  }

  async _handleRun(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }

    if (!body.command) return err(res, 400, 'body.command is required');

    const { command, timeoutMs } = body;

    try {
      const result = await entry.vm.run(command, timeoutMs ? { timeout: Math.floor(timeoutMs / 1000) } : {});
      this._metrics.runTotal++;
      send(res, 200, result);
    } catch (e) {
      this._metrics.runErrors++;
      err(res, 500, `Command failed: ${e.message}`);
    }
  }

  async _handlePipeline(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }

    if (!Array.isArray(body.commands) || body.commands.length === 0) {
      return err(res, 400, 'body.commands must be a non-empty array of strings');
    }

    const { commands, stopOnError = true } = body;

    const results = [];
    for (const command of commands) {
      try {
        const result = await entry.vm.run(command);
        this._metrics.runTotal++;
        results.push({ command, ...result, error: null });
        if (result.code !== 0 && stopOnError) {
          send(res, 200, { results, stopped: true, stoppedAt: command });
          return;
        }
      } catch (e) {
        this._metrics.runErrors++;
        results.push({ command, stdout: '', stderr: '', code: -1, error: e.message });
        if (stopOnError) {
          send(res, 200, { results, stopped: true, stoppedAt: command });
          return;
        }
      }
    }

    send(res, 200, { results, stopped: false });
  }

  async _handleUpload(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    let body;
    try {
      body = await parseBody(req, MAX_UPLOAD_BYTES);
    } catch (e) {
      return err(res, 400, e.message);
    }

    const { content, path: remotePath, encoding = 'base64' } = body;
    if (!content) return err(res, 400, 'body.content is required');
    if (!remotePath) return err(res, 400, 'body.path (remote destination) is required');

    // Write content to a temp file on the host, then scp it into the VM
    const tmpFile = join(tmpdir(), `carapace-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const data = encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');

      writeFileSync(tmpFile, data);
      await entry.vm.upload(tmpFile, remotePath);
      this._metrics.uploadTotal++;

      send(res, 200, {
        message: 'File uploaded successfully',
        vmId: id,
        path: remotePath,
        bytes: data.length,
      });
    } catch (e) {
      this._metrics.transferErrors++;
      err(res, 500, `Upload failed: ${e.message}`);
    } finally {
      // Clean up temp file on host
      try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  async _handleDownload(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    const url = new URL(req.url, `http://${this.host}`);
    const remotePath = url.searchParams.get('path');
    if (!remotePath) return err(res, 400, 'Query param "path" (remote file path) is required');

    const tmpFile = join(tmpdir(), `carapace-download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await entry.vm.download(remotePath, tmpFile);
      const data = readFileSync(tmpFile);
      this._metrics.downloadTotal++;

      send(res, 200, {
        vmId: id,
        path: remotePath,
        bytes: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    } catch (e) {
      this._metrics.transferErrors++;
      err(res, 500, `Download failed: ${e.message}`);
    } finally {
      try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ─── Snapshot Handlers ──────────────────────────────────────────────────────

  async _handleSnapshotSave(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }

    const { name } = body;
    if (!name) return err(res, 400, 'body.name is required (snapshot name)');

    try {
      const result = await entry.vm.saveSnapshot(name);
      this._metrics.snapshotTotal++;
      send(res, 200, {
        message: 'Snapshot saved',
        vmId: id,
        snapshot: result,
      });
    } catch (e) {
      this._metrics.snapshotErrors++;
      err(res, 500, `Snapshot failed: ${e.message}`);
    }
  }

  async _handleSnapshotList(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    try {
      const snapshots = await entry.vm.listSnapshots();
      send(res, 200, { vmId: id, snapshots });
    } catch (e) {
      err(res, 500, `Failed to list snapshots: ${e.message}`);
    }
  }

  async _handleSnapshotRestore(req, res, { id, snap }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);
    if (!snap) return err(res, 400, 'Snapshot name (snap) is required');

    try {
      await entry.vm.restoreSnapshot(snap);
      this._metrics.restoreTotal++;
      send(res, 200, {
        message: 'Snapshot restored',
        vmId: id,
        snapshot: snap,
      });
    } catch (e) {
      this._metrics.snapshotErrors++;
      err(res, 500, `Restore failed: ${e.message}`);
    }
  }

  async _handleSnapshotDelete(req, res, { id, snap }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);
    if (!snap) return err(res, 400, 'Snapshot name (snap) is required');

    try {
      await entry.vm.deleteSnapshot(snap);
      send(res, 200, { message: 'Snapshot deleted', vmId: id, snapshot: snap });
    } catch (e) {
      this._metrics.snapshotErrors++;
      err(res, 500, `Delete snapshot failed: ${e.message}`);
    }
  }

  // ─── VM Lifecycle ────────────────────────────────────────────────────────────

  async _handleRelease(req, res, { id }) {
    const entry = this.activeVMs.get(id);
    if (!entry) return err(res, 404, `VM not found: ${id}`);

    this.activeVMs.delete(id);
    const ageMs = Date.now() - entry.acquiredAt;

    try {
      await this.pool.release(entry.vm);
      this._metrics.releaseTotal++;
      send(res, 200, { message: 'VM released and destroyed', vmId: id, ageMs });
    } catch (e) {
      // Even if pool release fails, VM is gone from our tracking
      err(res, 500, `Release error (VM destroyed): ${e.message}`);
    }
  }

  async _handlePoolStatus(req, res) {
    if (!this.pool) return err(res, 503, 'Pool not initialized');
    const stats = this.pool.stats();
    const statusLine = this.pool.statusLine();
    send(res, 200, { ...stats, statusLine });
  }

  async _handlePoolResize(req, res) {
    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }

    const size = body.size;
    if (typeof size !== 'number' || size < 0 || size > 16) {
      return err(res, 400, 'body.size must be a number between 0 and 16');
    }

    // WarmPool doesn't have a direct resize; we track as config change
    // and refill will target new size on next release cycle
    const oldSize = this.pool.targetSize ?? this.poolSize;
    this.pool.targetSize = size;
    this.poolSize = size;

    // If growing, trigger refills
    if (size > oldSize) {
      this.pool._refill?.().catch(() => {});
    }

    send(res, 200, { message: `Pool resize requested: ${oldSize} → ${size}`, newSize: size });
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const image = args.find(a => !a.startsWith('--')) || process.env.CARAPACE_IMAGE;
  const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] ?? '7375');
  const poolSize = parseInt(args.find(a => a.startsWith('--pool='))?.split('=')[1] ?? '2');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const networkMode = args.find(a => a.startsWith('--network='))?.split('=')[1] ?? 'nat';
  const dnsServer = args.find(a => a.startsWith('--dns='))?.split('=')[1] ?? null;

  // Parse --allow=host:port entries into networkAllow[]
  const networkAllow = args
    .filter(a => a.startsWith('--allow='))
    .map(a => {
      const val = a.split('=')[1];
      const [host, port] = val.split(':');
      return { host, port: parseInt(port) };
    });

  if (!image) {
    console.error('Usage: control-server.js <path-to-carapaceos.qcow2> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --port=7375       HTTP port to listen on');
    console.error('  --pool=2          Number of warm VMs to pre-boot');
    console.error('  --network=MODE    Network mode: nat (default), isolated, allowlist, none');
    console.error('  --allow=HOST:PORT Allow outbound to HOST:PORT (requires --network=allowlist)');
    console.error('  --dns=IP          DNS server override');
    console.error('  --verbose, -v     Verbose logging');
    console.error('');
    console.error('  Or set CARAPACE_IMAGE env var');
    process.exit(1);
  }

  const server = new ControlServer({
    image, port, poolSize, verbose,
    networkMode, networkAllow, dnsServer,
  });

  process.on('SIGINT', async () => {
    console.log('\n[ControlServer] SIGINT received, shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });

  server.start().catch(e => {
    console.error('[ControlServer] Failed to start:', e.message);
    process.exit(1);
  });
}
