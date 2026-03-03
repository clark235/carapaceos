# 🦞 CarapaceOS

**Minimal Linux for AI Agents** — A lightweight Alpine-based VM image purpose-built for isolated AI agent execution.

[![npm version](https://img.shields.io/npm/v/carapaceos-runner.svg)](https://www.npmjs.com/package/carapaceos-runner)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What Is This?

CarapaceOS is two things:

1. **A bootable QEMU VM image** — Alpine Linux 3.21, purpose-built for AI agents (~180MB)
2. **`carapaceos-runner`** — A Node.js library for programmatically running agent tasks in isolated VMs

Perfect for when you need your AI agent to execute untrusted code, run user scripts, or operate in a clean environment that can be discarded after each task.

### VM Features

- **Alpine Linux 3.21** base (~180MB image, ~43MB RAM at idle)
- **Node.js 22**, npm, git, curl, jq pre-installed
- **Dedicated `agent` user** with workspace at `/home/agent/workspace`
- **Cloud-init** for zero-touch provisioning
- **SSH key-based auth** (no passwords)
- **OpenClaw-compatible** — runs OpenClaw out of the box
- Boots in **~25 seconds** with KVM acceleration

---

## Install

```bash
npm install carapaceos-runner
```

**System requirements:**
- Linux (KVM) or macOS (Hypervisor.framework via QEMU)
- `qemu-system-x86_64` in PATH
- `genisoimage` or `mkisofs` (for cloud-init seed ISO)
- ~500MB disk for the VM image

```bash
# Ubuntu/Debian
sudo apt install qemu-system-x86 genisoimage

# macOS
brew install qemu cdrtools
```

---

## Usage

### One-liner: boot, run, destroy

```javascript
import { runIsolated } from 'carapaceos-runner';

const result = await runIsolated('node --version', {
  image: '/path/to/carapaceos.qcow2'
});
// → { stdout: 'v22.15.1', stderr: '', code: 0, duration: 155 }
console.log(result.stdout); // v22.15.1
```

### Full lifecycle control

```javascript
import { CarapaceRunner } from 'carapaceos-runner';

const runner = new CarapaceRunner({
  image: '/path/to/carapaceos.qcow2',
  memory: '512',   // MB
  verbose: false,
  taskTimeout: 300 // seconds
});

await runner.boot();

// Run multiple commands in the same VM
await runner.run('cd /home/agent/workspace && git clone https://github.com/example/project');
await runner.run('cd /home/agent/workspace/project && npm install');
const result = await runner.run('cd /home/agent/workspace/project && npm test');

console.log('Tests passed:', result.code === 0);
console.log('Output:', result.stdout);

await runner.shutdown(); // VM destroyed, overlay image discarded
```

### Warm Pool — eliminate boot latency

Pre-boot a pool of VMs so agents get clean environments instantly (no 25s wait):

```javascript
import { WarmPool } from 'carapaceos-runner/warm-pool';

// Start a pool of 3 warm VMs
const pool = new WarmPool({
  image: './carapaceos.qcow2',
  size: 3,           // pre-boot 3 VMs
  memory: '512',
});
await pool.start();  // blocks until first VM is warm

// Instantly acquire a pre-booted VM — no boot wait!
const vm = await pool.acquire();
const result = await vm.run('node --version');

// Release destroys the VM (isolation guarantee) and refills pool in background
await pool.release(vm);

// At shutdown
await pool.stop();
```

Pool status:

```javascript
console.log(pool.statusLine());
// [WarmPool] warm=2 booting=1 active=1 waiters=0
console.log(pool.stats());
// { warm: 2, booting: 1, active: 1, total: 4, waiters: 0, targetSize: 3, maxSize: 8 }
```

**Performance:** Boot time amortized to ~0ms per task (vs 25s without pooling).

### Task pipelines

```javascript
const runner = new CarapaceRunner({ image: './carapaceos.qcow2' });
await runner.boot();

const results = await runner.runPipeline([
  'echo "step 1: env check" && node --version && npm --version',
  'cd /tmp && echo \'{"name":"test","version":"1.0.0"}\' > package.json',
  'cd /tmp && npm install lodash 2>&1 | tail -3',
  'cd /tmp && node -e "const _ = require(\'lodash\'); console.log(_.VERSION)"',
]);

results.forEach((r, i) => console.log(`Step ${i + 1}:`, r.stdout));
await runner.shutdown();
```

### CLI

```bash
# Install globally
npm install -g carapaceos-runner

# Run a command in an isolated VM
carapace-run "node --version"

# With options
carapace-run --image ./custom.qcow2 --memory 1024 --verbose "npm test"

# Keep VM running for debugging
carapace-run --keep "bash"
```

---

## Building the VM Image

Pre-built images are not yet published (coming soon). Build from source:

```bash
git clone https://github.com/clark235/carapaceos
cd carapaceos/vm-image

# Build the image (downloads Alpine cloud image ~50MB, provisions it)
bash build-image.sh

# Output: vm-image/carapaceos.qcow2 (~180MB)
```

Build takes ~2-5 minutes (mostly network + cloud-init first boot).

---

## Architecture

```
carapaceos/
├── index.js              # Public API exports
├── lib/
│   ├── agent-runner.js   # CarapaceRunner class
│   ├── cli.js            # carapace-run CLI
│   └── test-runner.js    # Integration tests
├── vm-image/
│   ├── build-image.sh    # Image builder (Alpine + cloud-init)
│   ├── create-seed-iso.js # Cloud-init seed ISO creator
│   ├── user-data.template # Cloud-init user-data
│   └── carapaceos.qcow2  # Built VM image (not in git)
└── SAFETY.md             # Security considerations
```

### How Isolation Works

Each `CarapaceRunner` boot creates a **copy-on-write overlay** on top of the base image. The base image is never modified. When the VM shuts down, the overlay is deleted — every run starts from a clean state.

```
Base image (carapaceos.qcow2) — read-only, shared
    └── Overlay (tmp/carapace-XXXX/overlay.qcow2) — per-run, discarded on shutdown
```

---

## Security

See [SAFETY.md](SAFETY.md) for security considerations. Key points:

- VMs are network-isolated (no host network by default)
- SSH key is ephemeral (generated fresh per boot, never stored)
- Overlay images are destroyed on shutdown
- KVM isolation (hardware virtualization boundary)

---

## Benchmarks

Measured on Linux/KVM (Intel i7):

| Metric | Value |
|--------|-------|
| Boot time (KVM) | ~25 seconds |
| Boot time (TCG/no-KVM) | ~90 seconds |
| SSH command latency | ~155ms |
| Idle RAM usage | ~43MB |
| Overlay image size | ~1MB (grows with writes) |

---

## HTTP Control Server

Run CarapaceOS as a local daemon that any agent (or HTTP client) can talk to:

```bash
# Start the control server (auto-manages a warm pool)
node lib/control-server.js ./vm-image/carapaceos.qcow2 --port=7375 --pool=2
# → [ControlServer] Listening on http://127.0.0.1:7375
```

### REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + pool stats |
| GET | `/metrics` | Prometheus-style metrics |
| GET | `/vms` | List active VMs |
| POST | `/vms/acquire` | Acquire a warm VM → `{ vmId }` |
| POST | `/vms/:id/run` | Run command in VM → `{ stdout, stderr, code }` |
| POST | `/vms/:id/pipeline` | Run multiple commands in sequence |
| POST | `/vms/:id/upload` | Upload file into VM (body: `{ content, path, encoding? }`) |
| GET | `/vms/:id/download?path=` | Download file from VM → `{ content (base64), bytes }` |
| POST | `/vms/:id/snapshots` | Save VM checkpoint (body: `{ name }`) |
| GET | `/vms/:id/snapshots` | List saved checkpoints |
| POST | `/vms/:id/snapshots/:snap/restore` | Roll back VM to checkpoint |
| DELETE | `/vms/:id/snapshots/:snap` | Delete a checkpoint |
| POST | `/vms/:id/release` | Destroy VM + refill pool |
| GET | `/pool/status` | Pool stats |
| POST | `/pool/resize` | Resize warm pool |

```javascript
// Any HTTP client can now use isolated VMs
const { vmId } = await fetch('http://127.0.0.1:7375/vms/acquire', { method: 'POST' }).then(r => r.json());

const result = await fetch(`http://127.0.0.1:7375/vms/${vmId}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command: 'node --version' }),
}).then(r => r.json());
// → { stdout: 'v22.15.1', stderr: '', code: 0, duration: 155 }

// Checkpoint/restore — save state before risky mutations
await fetch(`http://127.0.0.1:7375/vms/${vmId}/snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'before-npm-install' }),
});

await fetch(`http://127.0.0.1:7375/vms/${vmId}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command: 'npm install --save-dev some-risky-package' }),
});

// Something went wrong? Roll back instantly:
await fetch(`http://127.0.0.1:7375/vms/${vmId}/snapshots/before-npm-install/restore`, { method: 'POST' });

await fetch(`http://127.0.0.1:7375/vms/${vmId}/release`, { method: 'POST' });
```

---

## Status

- ✅ Bootable QEMU image (KVM + TCG fallback)
- ✅ Cloud-init provisioning (agent user, tools, SSH)
- ✅ Programmatic Node.js API
- ✅ Copy-on-write isolation (overlay images)
- ✅ Ephemeral SSH keys (per-boot)
- ✅ OpenClaw 2026.x validated running inside VM
- ✅ Native build tools (cmake, make, g++) for npm modules with native addons
- ✅ **Warm Pool** — pre-boot N VMs, acquire instantly (zero boot latency)
- ✅ **HTTP Control Server** — REST API for VM lifecycle (language-agnostic access)
- ✅ **File transfer** — upload/download files in/out of VMs via HTTP
- ✅ **Checkpoint/Restore** — save VM state mid-task, roll back on failure (QMP snapshots)
- ✅ **ARM64 / Apple Silicon support** — auto-detects host arch, selects QEMU binary
- ✅ **GitHub Actions CI** — unit tests + integration tests, ARM64 matrix
- 🔲 Pre-built images via GHCR
- 🔲 Network isolation options (NAT vs isolated)

---

## License

MIT — See [LICENSE](LICENSE) for details.

Built by [Clark](https://github.com/clark235) 🦞
