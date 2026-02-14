#!/bin/bash
# CarapaceOS automated boot test
# Boots the VM, waits for CARAPACEOS_READY signal, then verifies via SSH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="$SCRIPT_DIR/carapaceos.qcow2"
SEED="$SCRIPT_DIR/build/seed.iso"
SSH_PORT=2222
TIMEOUT=90
SSH_KEY="$SCRIPT_DIR/build/test_key"

echo "🧪 CarapaceOS Boot Test"
echo "======================="

[ -f "$IMAGE" ] || { echo "❌ No image. Run build first."; exit 1; }
[ -f "$SEED" ] || { echo "❌ No seed ISO. Run create-seed.py first."; exit 1; }

# Check if port is free
if ss -tln | grep -q ":${SSH_PORT} "; then
    echo "❌ Port $SSH_PORT already in use"
    exit 1
fi

# Boot in background
echo "🚀 Booting CarapaceOS..."
qemu-system-x86_64 \
    -drive file="$IMAGE",if=virtio,format=qcow2 \
    -cdrom "$SEED" \
    -m 512 \
    -display none \
    -serial file:"$SCRIPT_DIR/build/boot.log" \
    -netdev user,id=net0,hostfwd=tcp::${SSH_PORT}-:22 \
    -device virtio-net,netdev=net0 \
    -enable-kvm \
    -daemonize \
    -pidfile "$SCRIPT_DIR/build/qemu.pid"

QEMU_PID=$(cat "$SCRIPT_DIR/build/qemu.pid")
cleanup() { kill "$QEMU_PID" 2>/dev/null || true; rm -f "$SCRIPT_DIR/build/qemu.pid"; }
trap cleanup EXIT

# Wait for SSH to be available
echo "⏳ Waiting for SSH (up to ${TIMEOUT}s)..."
ELAPSED=0
while ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=2 -p $SSH_PORT agent@localhost echo "SSH_OK" 2>/dev/null; do
    sleep 3
    ELAPSED=$((ELAPSED + 3))
    if [ $ELAPSED -ge $TIMEOUT ]; then
        echo "❌ Timeout waiting for SSH"
        echo "--- Boot log ---"
        cat "$SCRIPT_DIR/build/boot.log" 2>/dev/null | tail -30
        exit 1
    fi
done

echo "✅ SSH connected!"

# Run validation checks
echo "🔍 Running validation checks..."
FAILURES=0

check() {
    local desc="$1"; shift
    local result
    result=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -p $SSH_PORT agent@localhost "$@" 2>/dev/null) || true
    if [ -n "$result" ]; then
        echo "  ✅ $desc: $result"
    else
        echo "  ❌ $desc: FAILED"
        FAILURES=$((FAILURES + 1))
    fi
}

check "OS version" "cat /etc/carapaceos-version"
check "Hostname" "hostname"
check "Node.js" "node --version"
check "npm" "npm --version"
check "git" "git --version"
check "Workspace" "ls -d /home/agent/workspace"
check "User" "whoami"
check "Memory" "free -h | head -2"

echo ""
if [ $FAILURES -eq 0 ]; then
    echo "🎉 All checks passed!"
    exit 0
else
    echo "⚠️  $FAILURES check(s) failed"
    exit 1
fi
