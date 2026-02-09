# Safety Guidelines

**CRITICAL: Do not break the host system.**

Clark's ability to operate depends on this machine running. All CarapaceOS development must be isolated.

## Allowed

- ✅ Docker containers for build experiments
- ✅ QEMU/KVM VMs for testing boot images
- ✅ Chroot environments (carefully)
- ✅ Analysis of package dependencies (read-only)
- ✅ Writing build scripts (without executing destructively)
- ✅ Azure VMs for testing ($25 budget)

## Forbidden

- ❌ Modifying host system packages
- ❌ Running `rm -rf` outside containers
- ❌ Changing host boot configuration
- ❌ Installing kernels on host
- ❌ Any command that could break OpenClaw's runtime

## Build Strategy

1. **Research phase** — Analyze deps, no execution
2. **Container phase** — Build in Docker, test in Docker
3. **VM phase** — Boot real images in QEMU or Azure VMs
4. **Never on host** — The host is sacred

## If Uncertain

Stop and ask Allan before running anything risky.
