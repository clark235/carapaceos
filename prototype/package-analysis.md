# CarapaceOS Package Analysis

## Core Requirements for AI Agents

### Tier 1: Absolute Minimum (Must Have)
| Package | Why | Alpine pkg | Debian pkg | Size (approx) |
|---------|-----|-----------|------------|---------------|
| Node.js | Runtime for OpenClaw | nodejs-current | nodejs | ~30MB |
| Bash | Shell for commands | bash | bash | ~1MB |
| Git | Code operations | git | git | ~5MB |
| curl | HTTP requests | curl | curl | ~200KB |
| CA certs | HTTPS | ca-certificates | ca-certificates | ~200KB |

**Tier 1 Total: ~37MB**

### Tier 2: Common Needs (Usually Required)
| Package | Why | Alpine pkg | Size (approx) |
|---------|-----|-----------|---------------|
| npm | Package management | npm | ~10MB |
| openssh-client | SSH operations | openssh-client | ~2MB |
| jq | JSON processing | jq | ~500KB |
| Python 3 | Many tools need it | python3 | ~50MB |

**Tier 2 Total: ~63MB**

### Tier 3: Build Tools (For compilation)
| Package | Why | Alpine pkg | Size (approx) |
|---------|-----|-----------|---------------|
| build-base | C/C++ compiler | build-base | ~150MB |
| python3-dev | Python extensions | python3-dev | ~20MB |

**Tier 3 Total: ~170MB**

## Image Size Targets

| Profile | Packages | Target Size |
|---------|----------|-------------|
| ultramin | Tier 1 only | < 50MB |
| standard | Tier 1 + 2 | < 120MB |
| full | All tiers | < 300MB |

## Comparison to Alternatives

| Base Image | Compressed | Uncompressed |
|-----------|-----------|--------------|
| Alpine 3.19 | 3.3 MB | 7 MB |
| Debian slim | 25 MB | 75 MB |
| Ubuntu 22.04 | 28 MB | 77 MB |
| node:22-alpine | 50 MB | 140 MB |
| node:22-slim | 70 MB | 200 MB |

## Unique Value of CarapaceOS

Unlike generic minimal images, CarapaceOS would include:
1. **Agent-specific hardening** — sandboxing, resource limits, audit logging
2. **Pre-configured for OpenClaw** — skills directory, memory structure
3. **Security defaults** — no root, minimal attack surface
4. **Fast startup** — optimized for ephemeral agent spawning
