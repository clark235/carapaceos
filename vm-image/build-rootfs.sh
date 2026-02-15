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

# User-data (cloud-init) — use template to avoid heredoc escaping issues
TEST_KEY="$BUILD_DIR/test_key"
if [ ! -f "$TEST_KEY" ]; then
    ssh-keygen -t ed25519 -f "$TEST_KEY" -N "" -C "carapaceos-test" >/dev/null 2>&1
fi
SSH_PUBKEY=$(cat "${TEST_KEY}.pub")

sed "s|__SSH_PUBKEY__|${SSH_PUBKEY}|" "$SCRIPT_DIR/user-data.template" > "$BUILD_DIR/cidata/user-data"

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
