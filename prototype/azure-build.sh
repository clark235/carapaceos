#!/bin/bash
# Build CarapaceOS using Azure Container Registry Build Tasks
# No local Docker required - builds in the cloud

set -e

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-carapaceos-build}"
REGISTRY_NAME="${REGISTRY_NAME:-crcarapaceos}"
LOCATION="${LOCATION:-eastus}"
VERSION="${VERSION:-0.1.0}"

echo "=== Azure Container Registry Build ==="
echo "Resource Group: $RESOURCE_GROUP"
echo "Registry: $REGISTRY_NAME"
echo "Location: $LOCATION"
echo ""

# Check Azure CLI
if ! command -v az &> /dev/null; then
    echo "❌ Azure CLI not found"
    exit 1
fi

# Check login
if ! az account show &> /dev/null; then
    echo "❌ Not logged in to Azure"
    exit 1
fi

# Create resource group if needed
echo "Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none 2>/dev/null || true

# Create registry if needed
echo "Creating container registry..."
az acr create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$REGISTRY_NAME" \
    --sku Basic \
    --output none 2>/dev/null || true

# Build ultramin image
echo ""
echo "Building ultramin image..."
az acr build \
    --registry "$REGISTRY_NAME" \
    --image "carapaceos:${VERSION}-ultramin" \
    --file Dockerfile.ultramin \
    .

# Build minimal image
echo ""
echo "Building minimal image..."
az acr build \
    --registry "$REGISTRY_NAME" \
    --image "carapaceos:${VERSION}-minimal" \
    --file Dockerfile.minimal \
    .

# List images
echo ""
echo "=== Built Images ==="
az acr repository show-tags \
    --name "$REGISTRY_NAME" \
    --repository carapaceos \
    --output table

echo ""
echo "✅ Build complete!"
echo ""
echo "To pull images:"
echo "  az acr login --name $REGISTRY_NAME"
echo "  docker pull ${REGISTRY_NAME}.azurecr.io/carapaceos:${VERSION}-ultramin"
