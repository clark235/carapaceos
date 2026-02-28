#!/bin/bash
# CarapaceOS VM Image Builder
# Creates a bootable Alpine Linux-based QEMU image for AI agents
#
# Requirements: qemu-img, qemu-system-x86_64, wget, sudo (for mount)
# Output: carapaceos.qcow2 - bootable QEMU image

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT="$SCRIPT_DIR/carapaceos.qcow2"
ALPINE_VERSION="3.21"
ALPINE_RELEASE="3.21.3"
# Allow arch override for multi-arch CI (e.g., CARAPACE_ALPINE_ARCH=aarch64 for ARM64 runners)
ALPINE_ARCH="${CARAPACE_ALPINE_ARCH:-x86_64}"
ALPINE_ISO="alpine-virt-${ALPINE_RELEASE}-${ALPINE_ARCH}.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/${ALPINE_ARCH}/${ALPINE_ISO}"
DISK_SIZE="2G"

# Validate supported architectures
case "$ALPINE_ARCH" in
  x86_64|aarch64) ;;
  *)
    echo "❌ Unsupported CARAPACE_ALPINE_ARCH: $ALPINE_ARCH (supported: x86_64, aarch64)"
    exit 1
    ;;
esac

echo "🦞 CarapaceOS Image Builder"
echo "==========================="
echo "🏗️  Target arch: $ALPINE_ARCH"

# Clean build dir
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Download Alpine ISO if not cached
if [ ! -f "$SCRIPT_DIR/$ALPINE_ISO" ]; then
    echo "📥 Downloading Alpine Linux ${ALPINE_RELEASE}..."
    wget -q --show-progress -O "$SCRIPT_DIR/$ALPINE_ISO" "$ALPINE_URL"
else
    echo "📦 Using cached Alpine ISO"
fi

# Create disk image
echo "💾 Creating ${DISK_SIZE} disk image..."
qemu-img create -f qcow2 "$OUTPUT" "$DISK_SIZE"

# Create cloud-init / answer file for unattended Alpine install
cat > "$BUILD_DIR/answers" << 'ANSWERS'
KEYMAPOPTS="us us"
HOSTNAMEOPTS="-n carapaceos"
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
"
TIMEZONEOPTS="-z UTC"
PROXYOPTS="none"
APKREPOSOPTS="-1"
SSHDOPTS="-c openssh"
NTPOPTS="-c chrony"
DISKOPTS="-m sys /dev/vda"
LABOROPTS="none"
ANSWERS

# Create post-install setup script
cat > "$BUILD_DIR/agent-setup.sh" << 'SETUP'
#!/bin/sh
# CarapaceOS Agent Setup - runs after first boot

set -e

echo "🦞 Setting up CarapaceOS agent environment..."

# Install Node.js and essential tools
apk add --no-cache nodejs npm git curl bash jq

# Create agent user (non-root)
adduser -D -s /bin/bash -h /home/agent agent
mkdir -p /home/agent/workspace
chown -R agent:agent /home/agent

# Agent environment config
cat > /home/agent/.profile << 'EOF'
export PATH="$HOME/.npm-global/bin:$PATH"
export AGENT_WORKSPACE="$HOME/workspace"
export CARAPACEOS_VERSION="0.1.0"
cd "$AGENT_WORKSPACE"
echo "🦞 CarapaceOS $(cat /etc/carapaceos-version 2>/dev/null || echo 'dev')"
echo "Agent workspace: $AGENT_WORKSPACE"
EOF

# npm global config (no sudo needed)
su - agent -c 'mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global'

# Write version file
echo "0.1.0-alpha" > /etc/carapaceos-version

# Security hardening
# - Disable root login via SSH
sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# - Install and run the agent audit
cp /tmp/agent-audit.js /home/agent/workspace/
chown agent:agent /home/agent/workspace/agent-audit.js

echo "✅ CarapaceOS agent environment ready"
echo "Login as 'agent' user to begin"
SETUP

chmod +x "$BUILD_DIR/agent-setup.sh"

if [ "$ALPINE_ARCH" = "aarch64" ]; then
  QEMU_BIN="qemu-system-aarch64"
  QEMU_MACHINE="-M virt -cpu cortex-a57 -bios /usr/share/qemu-efi-aarch64/QEMU_EFI.fd"
else
  QEMU_BIN="qemu-system-x86_64"
  QEMU_MACHINE="-M pc"
fi

echo ""
echo "✅ Build artifacts ready in $BUILD_DIR"
echo "📀 Disk image: $OUTPUT"
echo "🏗️  Alpine arch: $ALPINE_ARCH"
echo ""
echo "To install Alpine into the image (interactive):"
echo "  $QEMU_BIN $QEMU_MACHINE -m 512 -cdrom $SCRIPT_DIR/$ALPINE_ISO \\"
echo "    -drive file=$OUTPUT,if=virtio -boot d -nographic"
echo ""
echo "To boot the installed image:"
echo "  $QEMU_BIN $QEMU_MACHINE -m 512 -drive file=$OUTPUT,if=virtio \\"
echo "    -nographic -netdev user,id=net0,hostfwd=tcp::2222-:22 \\"
echo "    -device virtio-net,netdev=net0"
