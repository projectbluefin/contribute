# justfile — developer entry points for the hive-contribute appliance.
#
# The launcher is `bin/hive-contribute`, and it is the only implementation:
# these recipes call it so a checkout and an installed appliance cannot drift.
# All site configuration lives in one file, which the launcher creates on first
# run: ${XDG_CONFIG_HOME:-~/.config}/hive-contribute.yml
#
# Hive owns task selection, assignment, and completion. OMP owns model and
# effort. This repository owns the isolation boundary, the credentials that
# cross it, and the image that carries Hive's current contributor runtime —
# which is tracked, never pinned.
[doc("Run the Hive contributor worker in the foreground.")]
contribute:
    @bin/hive-contribute run

[doc("Preflight diagnostics for this machine. Starts no agent.")]
doctor:
    @bin/hive-contribute doctor

[doc("Register this machine with a hive through Hive's own setup.")]
setup:
    @bin/hive-contribute setup

[doc("Print the resolved appliance configuration.")]
config:
    @bin/hive-contribute config
# Build the contributor image from this checkout and hold it to its contract.
# The version is derived, never typed: FSDK series from the base image plus
# image/contribute/REVISION.
#
# HIVE_COMMIT is resolved HERE, from Hive's tracking branch, and passed in as a
# build argument. Nothing in this repository stores it: resolving it per build
# is what keeps the image on Hive's current runtime, and passing it in is what
# moves the layer cache key when upstream moves. Resolve it inside the build
# instead and every rebuild reuses the first fetch.
[doc("Build the contributor image locally and verify its contract.")]
contribute-build tag="localhost/hive/contribute:dev":
    #!/usr/bin/env bash
    set -euo pipefail
    ENGINE="${CONTAINER_ENGINE:-podman}"
    VERSION="$(bash scripts/contribute-version.sh)"
    HIVE_COMMIT="$(git ls-remote https://github.com/hivecommons/hive refs/heads/v5 | cut -f1)"
    [[ "$HIVE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "could not resolve hivecommons/hive v5" >&2; exit 1; }
    echo "→ building {{tag}} as version ${VERSION} with Hive ${HIVE_COMMIT:0:12}"
    "$ENGINE" build \
      --format oci \
      --build-arg CONTRIBUTE_VERSION="$VERSION" \
      --build-arg CONTRIBUTE_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
      --build-arg HIVE_COMMIT="$HIVE_COMMIT" \
      --file image/contribute/Containerfile \
      --tag "{{tag}}" \
      .
    bash tests/contribute-contract.sh --image "{{tag}}"
