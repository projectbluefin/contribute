#!/usr/bin/env bash
# tests/brew-install-e2e.sh
#
# End-to-end test of Homebrew and bluefin-contributor-tools installation
# inside a clean, blank container environment from scratch.
#
# Verifies:
# 1. Fresh Homebrew installation via official installer script
# 2. Tapping ublue-os/homebrew-experimental-tap
# 3. Installing ublue-os/experimental-tap/bluefin-contributor-tools
# 4. Correct placement and executability of `bluefin` and `bluefin-contribute`
# 5. CLI usage invocation and argument validation
# 6. `brew test bluefin-contributor-tools` pass

set -euo pipefail

command -v apptainer >/dev/null 2>&1 || {
  echo "SKIP: apptainer is not available on host" >&2
  exit 0
}

# Override with BREW_TEST_CONTAINER to reuse a locally cached image.
CONTAINER_IMAGE="${BREW_TEST_CONTAINER:-docker://docker.io/homebrew/ubuntu22.04:latest}"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/linuxbrew" "$scratch/home"

# shellcheck disable=SC2016 # Expanded by the container's shell, not this one.
apptainer exec --cleanenv --home "$scratch/home" \
  --bind "$scratch/linuxbrew:/home/linuxbrew" \
  "$CONTAINER_IMAGE" bash -c '
set -euo pipefail

echo "==> Installing Homebrew from scratch in clean container..."
CI=1 NONINTERACTIVE=1 /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

echo "==> Configuring shell environment..."
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

echo "==> Verifying brew binary..."
brew --version

echo "==> Tapping ublue-os/experimental-tap..."
mkdir -p "$(brew --repository)/Library/Taps/ublue-os"
git clone --depth=1 https://github.com/ublue-os/homebrew-experimental-tap.git "$(brew --repository)/Library/Taps/ublue-os/homebrew-experimental-tap"

echo "==> Installing bluefin-contributor-tools..."
brew install --ignore-dependencies ublue-os/experimental-tap/bluefin-contributor-tools

echo "==> Verifying installed executables..."
test -x "$(brew --prefix)/bin/bluefin"
test -x "$(brew --prefix)/bin/bluefin-contribute"

echo "==> Testing CLI usage output..."
bluefin_out="$("$(brew --prefix)/bin/bluefin" 2>&1 || true)"
echo "$bluefin_out" | grep -q "Usage: bluefin {contribute|review}"

echo "==> Running brew formula test..."
brew test bluefin-contributor-tools

echo "==> Brew installation e2e test passed successfully!"
'
