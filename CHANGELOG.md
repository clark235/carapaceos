# Changelog

All notable changes to `carapaceos-runner` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.1] — 2026-02-28

### Added

- **ARM64 CI matrix** — `ubuntu-24.04-arm` runners added to both `doctor` and `integration` jobs in `.github/workflows/ci.yml`
  - Doctor job: validates QEMU binary on x86_64 and arm64 in parallel
  - Integration job: builds and boots VM on both architectures with correct QEMU binary
  - Cache key is now arch-scoped (`carapaceos-image-{arch}-{hash}`) to prevent cross-arch cache pollution
  - Uses `CARAPACE_ALPINE_ARCH=aarch64` env var to select the aarch64 Alpine ISO on ARM runners

- **`CARAPACE_ALPINE_ARCH` env override** in `vm-image/build-image.sh`
  - Supports `x86_64` (default) and `aarch64`
  - Selects correct Alpine ISO and QEMU boot hints automatically
  - Validates arch value; exits non-zero on unknown arch
  - Prints target arch + correct `qemu-system-*` boot command in output

### Changed

- `build-image.sh` boot summary now prints arch-specific `qemu-system-aarch64` command on ARM builds

---

## [0.2.0] — 2026-02-26

### Added

- **WarmPool** (`lib/warm-pool.js`) — pre-boot N VMs so agents get clean environments instantly (zero boot latency)
  - `pool.acquire()` — atomically dequeues a warm VM; blocks with timeout if pool is empty
  - `pool.release(vm)` — destroys VM (no recycling — isolation guarantee), refills pool in background
  - `pool.stats()` — `{ warm, booting, active, total, waiters, targetSize, maxSize }`
  - `pool.statusLine()` — human-readable one-liner for logging
  - `maxWarmAgeMs` — evicts stale warm VMs (prevents long-idle state drift)
  - `maxSize` cap — hard limit on concurrent VMs to prevent runaway allocation
  - `getGlobalPool()` / `stopGlobalPool()` — process-scoped singleton helpers

- **HTTP Control Server** (`lib/control-server.js`) — REST API for language-agnostic VM lifecycle
  - `GET /health` — health check + pool stats
  - `GET /metrics` — Prometheus-style counters
  - `GET /vms` — list active VMs
  - `POST /vms/acquire` — acquire a warm VM → `{ vmId }`
  - `POST /vms/:id/run` — run command → `{ stdout, stderr, code, duration }`
  - `POST /vms/:id/pipeline` — run multiple commands in sequence
  - `POST /vms/:id/release` — destroy VM + refill pool
  - `GET /pool/status` — pool stats
  - `POST /pool/resize` — resize warm pool target

- **Image fetcher** (`lib/image-fetch.js`) — downloads pre-built images from GHCR or GitHub Releases
  - CLI: `carapace-fetch [--tag v0.2.0] [--out path] [--force] [--check]`
  - ORAS-based OCI pull with fallback to `gh release download`
  - `--check` mode: detect if a fresh image is available without downloading

- **GitHub Actions CI** (`.github/workflows/ci.yml`)
  - Unit tests on Node 18/20/22
  - Export smoke-check
  - `carapace-doctor` run (reports missing deps, non-fatal)
  - Integration test on push to `main` (builds image, boots, runs `node --version`)

- **GitHub Actions publish workflow** (`.github/workflows/publish-image.yml`)
  - Triggered on tags matching `v*`
  - Builds `carapaceos.qcow2` via `build-image.sh`
  - Pushes image artifact to GHCR via ORAS

- **ARM64 architecture support** in `lib/agent-runner.js`
  - Auto-detects host arch (`process.arch`)
  - Selects `qemu-system-aarch64` + `-M virt -cpu cortex-a57` on `arm64`
  - Defaults to `qemu-system-x86_64` + `-M pc` on `x64`
  - `carapace-doctor` validates correct QEMU binary for detected arch

- **Package exports** — full `exports` map for Node ESM subpath imports:
  - `.` — main API (`CarapaceRunner`, `runIsolated`, `WarmPool`, `ControlServer`, `createSeedISO`)
  - `./runner` — `CarapaceRunner` only
  - `./warm-pool` — `WarmPool` only
  - `./seed-iso` — ISO helpers only
  - `./control-server` — `ControlServer` only
  - `./doctor` — doctor script
  - `./image-fetch` — image downloader

### Changed

- `package.json` bumped to `0.2.0`
- `bin` now exports `carapace-run`, `carapace-doctor`, and `carapace-fetch`
- README fully rewritten to document WarmPool, ControlServer, and image fetch workflows
- `index.js` updated with all new exports

### Fixed

- SSH port allocation uses random offset in range 12200–12299 to avoid conflicts with multiple concurrent runners

---

## [0.1.0] — 2026-02-24

### Added

- **Bootable QEMU image** — Alpine Linux 3.21, purpose-built for AI agents
  - `vm-image/build-image.sh` — downloads Alpine cloud image, provisions via cloud-init
  - `vm-image/user-data.template` — cloud-init user-data: agent user, SSH, Node.js 22, npm, git, jq, cmake, make, g++
  - Boot time: ~25 seconds (KVM), ~90 seconds (TCG/no-KVM)
  - Idle RAM: ~43 MB

- **Copy-on-write isolation** — each run creates an overlay on top of the base image; base is never modified; overlay is destroyed on shutdown

- **Ephemeral SSH keys** — fresh ed25519 key pair generated per boot; never stored after VM shutdown

- **CarapaceRunner class** (`lib/agent-runner.js`) — programmatic Node.js API
  - `runner.boot()` — creates overlay, generates SSH key, boots QEMU, waits for SSH
  - `runner.run(cmd, opts)` — executes command in VM via SSH; returns `{ stdout, stderr, code, duration }`
  - `runner.runPipeline(cmds)` — sequential multi-step execution
  - `runner.shutdown()` — graceful poweroff + cleanup
  - `runner.status` — `idle | booting | running | stopped`

- **`runIsolated(cmd, opts)`** — one-liner convenience function (boot → run → shutdown)

- **Pure-Node ISO 9660 seed generator** (`lib/seed-iso.js`) — creates cloud-init seed ISO with zero external dependencies
  - `createSeedISO({ sshPublicKey, outputPath, hostname?, extraRuncmds? })`
  - `buildISO(files)` — raw ISO 9660 builder

- **CLI** (`lib/cli.js` → `carapace-run`) — run a command in an isolated VM from the terminal
  - `carapace-run "node --version"`
  - `carapace-run --image ./custom.qcow2 --memory 1024 --verbose "npm test"`
  - `carapace-run --keep "bash"` — keep VM running for debugging

- **Doctor CLI** (`lib/doctor.js` → `carapace-doctor`) — validates host environment
  - Checks: QEMU binary, KVM availability, genisoimage/mkisofs, Node version, disk space

- **OpenClaw 2026.x validated** — OpenClaw installs and runs correctly inside the VM

- **Native build tools** — cmake, make, g++ pre-installed for npm modules with native addons

- **Test suite** — 60 unit tests, no QEMU required (pure mocks)
  - `lib/test-seed-iso.js` — 23 tests
  - `lib/test-warm-pool.js` — 14 tests
  - `lib/test-control-server.js` — 23 tests

---

[0.2.1]: https://github.com/clark235/carapaceos/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/clark235/carapaceos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/clark235/carapaceos/releases/tag/v0.1.0
