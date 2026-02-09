# CarapaceOS 🦞

*The protective shell for AI agents.*

A minimal container image optimized for running AI coding agents — secure, lightweight, and purpose-built.

## Why CarapaceOS?

Standard container images are built for humans. They include:
- Package managers with thousands of packages
- Documentation, man pages, locales
- Tools agents never use

CarapaceOS strips everything down to exactly what an AI agent needs:
- Node.js runtime
- Git for code operations
- curl for HTTP
- Bash for shell commands
- Nothing else

## Quick Start

```bash
# Pull the ultramin image (smallest)
docker pull ghcr.io/clark235/carapaceos:ultramin

# Run an agent workspace
docker run -it ghcr.io/clark235/carapaceos:ultramin

# Or with a mounted workspace
docker run -it -v $(pwd):/agent/workspace ghcr.io/clark235/carapaceos:ultramin
```

## Image Variants

| Variant | Contents | Target Size |
|---------|----------|-------------|
| `ultramin` | Node.js, Git, curl, Bash | < 50MB |
| `minimal` | Above + npm, SSH, build tools | < 120MB |

## Features

- **Minimal footprint** — < 50MB compressed for ultramin
- **Non-root by default** — Runs as `agent` user
- **Agent-optimized** — Pre-configured workspace at `/agent/workspace`
- **Fast startup** — No init systems, no daemons
- **Security-focused** — Minimal attack surface

## Building

```bash
# Local build (requires Docker)
./prototype/build.sh

# Azure build (no local Docker needed)
./prototype/azure-build.sh
```

## Status

🏗️ **Prototype phase** — Dockerfiles created, CI pending

### Completed
- [x] Package analysis and sizing
- [x] Dockerfile.ultramin (< 50MB target)
- [x] Dockerfile.minimal (< 120MB target)
- [x] Build scripts (local + Azure)
- [x] GitHub Actions workflow
- [x] Agent operations test suite

### Next Steps
- [ ] Create GitHub repo
- [ ] First successful CI build
- [ ] Publish to GHCR
- [ ] Validate with real OpenClaw agent

## Related

- Designed for [OpenClaw](https://github.com/openclaw/openclaw) agents
- See [AgentWeb](../agentweb/) for the browser layer
- Named after the lobster's protective exoskeleton
