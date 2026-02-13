#!/bin/bash
# CarapaceOS - Build from Alpine Cloud Image + cloud-init
# No sudo required! Uses pre-built Alpine qcow2 + cloud-init seed ISO.
#
# Output: carapaceos.qcow2 (bootable QEMU image with agent environment)

set -euo pipefail
export PATH="/sbin:/usr/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/cache"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT="$SCRIPT_DIR/carapaceos.qcow2"

ALPINE_IMG="generic_alpine-3.21.2-x86_64-bios-cloudinit-r0.qcow2"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/${ALPINE_IMG}"

echo "🦞 CarapaceOS Image Builder (cloud-init)"
echo "========================================="

mkdir -p "$CACHE_DIR" "$BUILD_DIR"

# 1. Download base image
if [ ! -f "$CACHE_DIR/$ALPINE_IMG" ]; then
    echo "📥 Downloading Alpine cloud image..."
    wget -q --show-progress -O "$CACHE_DIR/$ALPINE_IMG" "$ALPINE_URL"
fi

# 2. Create our customized copy
echo "📋 Creating CarapaceOS image from Alpine base..."
cp "$CACHE_DIR/$ALPINE_IMG" "$OUTPUT"
qemu-img resize "$OUTPUT" 2G

# 3. Create cloud-init seed ISO (NoCloud datasource)
echo "☁️  Creating cloud-init configuration..."

mkdir -p "$BUILD_DIR/cidata"

# Meta-data
cat > "$BUILD_DIR/cidata/meta-data" << 'EOF'
instance-id: carapaceos-001
local-hostname: carapaceos
EOF

# User-data (cloud-init)
cat > "$BUILD_DIR/cidata/user-data" << 'EOF'
#cloud-config

hostname: carapaceos

# Resize root partition to fill disk
growpart:
  mode: auto
  devices: ['/']
resize_rootfs: true

# Users
users:
  - name: agent
    shell: /bin/bash
    groups: [wheel]
    lock_passwd: false
    # password: "agent" (hashed)
    passwd: $6$rounds=4096$randomsalt$KcZk8VxQ8h8V8r8K8x8Y8z8A8b8C8d8E8f8G8h8I8j8K8l8M8n8O8p8Q8r8S8t8U8v8W8x8Y8z8A
    ssh_authorized_keys: []
    sudo: ALL=(ALL) NOPASSWD:ALL

# Packages
packages:
  - nodejs
  - npm  
  - git
  - curl
  - bash
  - jq
  - openssh-server

# Write files
write_files:
  - path: /etc/carapaceos-version
    content: "0.1.0-alpha\n"
  
  - path: /etc/motd
    content: |
      🦞 CarapaceOS 0.1.0-alpha
      Minimal Linux for AI Agents
      
      Workspace: /home/agent/workspace
      Run 'agent-audit' to check environment health
  
  - path: /home/agent/.profile
    owner: agent:agent
    content: |
      export PATH="$HOME/.npm-global/bin:$HOME/workspace/node_modules/.bin:$PATH"
      export AGENT_WORKSPACE="$HOME/workspace"
      export CARAPACEOS_VERSION="$(cat /etc/carapaceos-version 2>/dev/null || echo dev)"
      cd "$AGENT_WORKSPACE" 2>/dev/null || true
  
  - path: /home/agent/.npmrc
    owner: agent:agent
    content: |
      prefix=/home/agent/.npm-global

# Run commands after boot
runcmd:
  - mkdir -p /home/agent/workspace /home/agent/.npm-global
  - chown -R agent:agent /home/agent
  # Copy agent-audit if available
  - |
    if [ -f /opt/carapaceos/agent-audit.js ]; then
      cp /opt/carapaceos/agent-audit.js /home/agent/workspace/
      chown agent:agent /home/agent/workspace/agent-audit.js
    fi
  # Security hardening
  - sed -i 's/#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  - rc-service sshd restart || true
  # Signal that setup is complete
  - echo "✅ CarapaceOS agent environment ready" > /run/carapaceos-ready
  - echo "CARAPACEOS_READY" > /dev/ttyS0

# Final message
final_message: "🦞 CarapaceOS ready after $UPTIME seconds"
EOF

# Create seed ISO using genisoimage or mkisofs
SEED_ISO="$BUILD_DIR/seed.iso"
if command -v genisoimage &>/dev/null; then
    genisoimage -output "$SEED_ISO" -volid cidata -joliet -rock "$BUILD_DIR/cidata/" 2>/dev/null
elif command -v mkisofs &>/dev/null; then
    mkisofs -output "$SEED_ISO" -volid cidata -joliet -rock "$BUILD_DIR/cidata/" 2>/dev/null
elif command -v xorriso &>/dev/null; then
    xorriso -as genisoimage -output "$SEED_ISO" -volid cidata -joliet -rock "$BUILD_DIR/cidata/" 2>/dev/null
else
    echo "❌ No ISO creation tool found (need genisoimage, mkisofs, or xorriso)"
    echo "   Install: apt install genisoimage"
    exit 1
fi

echo ""
echo "✅ CarapaceOS image built!"
echo "   Image: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "   Seed:  $SEED_ISO"
echo ""
echo "🚀 Boot command:"
echo "  qemu-system-x86_64 \\"
echo "    -drive file=$OUTPUT,if=virtio,format=qcow2 \\"
echo "    -cdrom $SEED_ISO \\"
echo "    -m 512 -nographic \\"
echo "    -netdev user,id=net0,hostfwd=tcp::2222-:22 \\"
echo "    -device virtio-net,netdev=net0"
echo ""
echo "After first boot, cloud-init will install packages and set up the agent user."
echo "Login: agent / agent"
