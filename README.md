# 🦞 CarapaceOS

**Minimal Linux for AI Agents** — A lightweight Alpine-based VM image purpose-built for running AI agent frameworks like OpenClaw.

## What Is This?

CarapaceOS is a bootable QEMU virtual machine image that provides:

- **Alpine Linux 3.21** base (~180MB image)
- **Node.js 22**, npm, git, curl, jq pre-installed  
- **Dedicated `agent` user** with workspace at `/home/agent/workspace`
- **Cloud-init** for zero-touch provisioning
- **SSH access** with key-based auth
- **OpenClaw bootstrap** script included
- Boots in **~25 seconds** with KVM

## Quick Start

```bash
# 1. Build the image
cd vm-image
pip3 install pycdlib  # for seed ISO creation
bash build-rootfs.sh  # downloads Alpine cloud image, creates seed
python3 create-seed.py

# 2. Boot
./boot.sh

# 3. SSH in (default user: agent)
ssh -p 2222 agent@localhost

# 4. Install OpenClaw
bash ~/workspace/bootstrap.sh
```

## Requirements

- QEMU with KVM support
- Python 3 + pycdlib (for seed ISO)
- ~500MB disk space

## Architecture

```
vm-image/
├── build-rootfs.sh    # Main image builder
├── create-seed.py     # Cloud-init seed ISO creator (pycdlib)
├── boot.sh            # QEMU launch script
├── test-boot.sh       # Automated boot + SSH validation test
├── build/
│   └── cidata/        # Cloud-init configuration
│       ├── meta-data
│       └── user-data  # Packages, users, security, bootstrap
└── cache/             # Downloaded Alpine base images
```

## Status

- ✅ Bootable QEMU image (KVM)
- ✅ Cloud-init provisioning (agent user, tools, SSH)
- ✅ Automated boot test (test-boot.sh)
- ✅ OpenClaw bootstrap script
- 🔲 GitHub Actions CI boot test
- 🔲 Pre-built images (GHCR)
- 🔲 ARM64 support

## License

MIT
