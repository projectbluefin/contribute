---
name: image-build
version: "3.0"
last_updated: 2026-09-14
id: image-build
one_line_purpose: Build and pin the OMP review and contributor images.
entry_point: docs/skills/image-build.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [containerfile, image, digest, pinning, omp, hive]
description: "Use when maintaining the distroless OMP review appliance or the OMP Hive contributor image."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en, /websites/github_en_actions]
---
# Image Build

The repository ships two images:

| Image | Source | Purpose |
| --- | --- | --- |
| `ghcr.io/projectbluefin/review` | `image/appliance/Containerfile` | OMP maintainer workbench and extension |
| `ghcr.io/projectbluefin/contribute` | `image/contribute/Containerfile` | Hive-assigned OMP worker |

There is no `review-contributor` image, SIF package, alternate agent harness, or
model-specific runtime. Both OCI images leave model and effort selection to OMP.

## Rules

1. Pin base images by tag and digest. Pin fetched artifacts by version and
   architecture-specific SHA-256.
2. Build natively per architecture; do not claim QEMU results as native evidence.
3. Never place credentials, user configuration, workspaces, or provider choices
   in an image layer.
4. Do not add package managers or duplicate a tool already present in the pinned
   FSDK closure.
5. The review appliance carries OMP, its extension, GitHub CLI, and the minimal
   shell/git/Python closure required by OMP tools.
6. The contributor image carries OMP, Hive's pinned relay/runtime, Node with the
   locked `ws` module, GitHub CLI, tmux, and the minimal FSDK closure.
7. The contributor entrypoint accepts only `AGENT_BACKEND=omp`; provider, model,
   and effort remain OMP configuration, never launcher or image policy.
8. Local launchers prefer Podman's `krun` runtime. Merely checking or mounting
   `/dev/kvm` is not isolation; `--runtime=krun` is the VM boundary. Missing KVM
   prerequisites produce a warning and select the isolated Apptainer fallback.
9. Preserve Hive's assignment, lease, prompt, credential, and output protocol.
   Do not fork or locally patch its runtime files.
10. Generate SPDX manifests from resolved build arguments and keep build-only
    generators out of the final filesystem.

## Pin maintenance

Hive's source pin appears in `justfile` and `image/contribute/Containerfile`.
Move both together from Hive's `v4` branch. The review and contribute image
revision files are separate product revisions.

## Verification

```bash
bash tests/appliance-contract.sh
bash tests/contribute-contract.sh
python3 tests/appliance_sbom_contract.py
python3 tests/contribute_sbom_contract.py
git diff --check
```

With a container engine, build through `just review-appliance-build` and the
publish-contribute workflow's native build path.
