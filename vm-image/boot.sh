#!/bin/bash
# Boot CarapaceOS in QEMU
# Usage: ./boot.sh [--test]  (--test exits after 30s)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="$SCRIPT_DIR/carapaceos.qcow2"
SEED="$SCRIPT_DIR/build/seed.iso"

if [ ! -f "$IMAGE" ]; then
    echo "❌ No image found. Run build first."
    exit 1
fi

EXTRA_ARGS=""
if [ "$1" = "--test" ]; then
    EXTRA_ARGS="-no-reboot"
fi

exec qemu-system-x86_64 \
    -drive file="$IMAGE",if=virtio,format=qcow2 \
    -cdrom "$SEED" \
    -m 512 \
    -nographic \
    -netdev user,id=net0,hostfwd=tcp::2222-:22 \
    -device virtio-net,netdev=net0 \
    -enable-kvm \
    $EXTRA_ARGS
