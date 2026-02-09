#!/bin/bash
# CarapaceOS Build Script
# Run in any environment with Docker

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${VERSION:-0.1.0}"

echo "=== CarapaceOS Build Script ==="
echo "Version: $VERSION"
echo "Directory: $SCRIPT_DIR"

# Build ultramin image
echo ""
echo "Building ultramin image..."
docker build \
    -f "$SCRIPT_DIR/Dockerfile.ultramin" \
    -t "carapaceos:${VERSION}-ultramin" \
    "$SCRIPT_DIR"

# Build minimal image (includes npm, dev tools)
echo ""
echo "Building minimal image..."
docker build \
    -f "$SCRIPT_DIR/Dockerfile.minimal" \
    -t "carapaceos:${VERSION}-minimal" \
    "$SCRIPT_DIR"

# Report sizes
echo ""
echo "=== Image Sizes ==="
docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep carapaceos

# Run smoke tests
echo ""
echo "=== Smoke Tests ==="
echo "Testing ultramin..."
docker run --rm "carapaceos:${VERSION}-ultramin" -c "node --version && git --version"

echo "Testing minimal..."
docker run --rm "carapaceos:${VERSION}-minimal" -c "node --version && npm --version && git --version"

echo ""
echo "✅ Build complete!"
