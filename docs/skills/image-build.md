---
name: image-build
version: "3.7"
last_updated: "2026-09-19"
id: image-build
one_line_purpose: Build and pin the OMP contributor image.
entry_point: docs/skills/image-build.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [containerfile, image, digest, pinning, omp, hive]
description: "Use when maintaining the OMP contributor image, release pins, SBOM inputs, or multi-architecture publication workflows."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en, /websites/github_en_actions, /renovatebot/renovate]
---

# Image Build

The repository ships one image:

| Image | Source | Purpose |
| --- | --- | --- |
| `ghcr.io/projectbluefin/contribute` | `image/contribute/Containerfile` | Hive-assigned OMP worker (registry location) |

There is no SIF package, alternate agent harness, or model-specific runtime.
The OCI image leaves model and effort selection to OMP.

## Rules

1. Base images (`ghcr.io/projectbluefin/base:26.08`, `ghcr.io/projectbluefin/lab-runner:26.08`)
   are pinned by tag and digest as build inputs. Pin fetched third-party binary release artifacts
   by version and architecture-specific SHA-256.
2. Build natively per architecture; do not claim QEMU results as native evidence.
3. Never place credentials, user configuration, workspaces, or provider choices
   in an image layer.
4. Do not add package managers or duplicate a tool already present in the base
   image closure.
5. The contributor image carries OMP, Hive's runtime (`contributor-agent.sh`,
   `contributor-relay.js`, `pi-backend.js`, `lib/pane-classifier.js`,
   `backends.conf`), Hive's `gh` policy layer (`gh-wrapper.sh` installed as the
   agent's `gh`, the real binary at `/opt/hive/bin/gh-real`, the root-owned
   `/etc/hive/contributor-mode` marker, and `restrictions/contributor-default.json`),
   Node with the locked `ws` module, GitHub CLI, tmux, and the minimal base closure.
   `omp-backend.js` is host-side staging for upstream's own recipe and is not in
   the closure; upstream's contributor image does not ship it either.
6. The contributor entrypoint accepts only `AGENT_BACKEND=omp`; provider, model,
   and effort remain OMP configuration, never launcher or image policy.
7. Local launchers prefer Podman's `krun` runtime. Merely checking or mounting
   `/dev/kvm` is not isolation; `--runtime=krun` is the VM boundary. Missing KVM
   prerequisites produce a warning and run standard Podman containers.
8. Preserve Hive's assignment, lease, prompt, credential, and output protocol.
   Do not fork or locally patch its runtime files.
9. Generate SPDX manifests from resolved build arguments and keep build-only
   generators out of the final filesystem.
10. Version derivation rejects malformed or missing revision/base inputs,
    preserves decimal `08`/`09` revisions, and keeps the contributor image series aligned.
11. Execute every staged command in the built image. If an allowlisted path is
    a wrapper, stage and verify its real executable target as part of the same
    closure; file presence is not runtime evidence.
13. OMP version and digest pins are updated when OMP releases.
    The scheduled Renovate workflow refreshes the GitHub release asset digests,
    merges the validated OMP update, and lets the resulting `main` push publish
    the image. Renovate creates a branch before it creates a pull request, and
    only PR creation is rate-limited: the four shipped runtime pins (OMP,
    GitHub CLI, Node.js, tmux) therefore carry a `packageRules` entry setting
    `prConcurrentLimit` and `prHourlyLimit` to `0`. Without it they queue behind
    this repository's daily digest updates and never reach the front — the
    branch stays current, no pull request is ever opened, and the shipped image
    ages while every signal reads healthy. `tests/renovate-tracking.test.mjs`
    fails if that exemption or a tracking regex is dropped, and the Renovate
    workflow fails when a pin is behind upstream with no open pull request
    carrying the latest release.

    A post-upgrade command does not inherit the workflow job's environment.
    Renovate builds one from its own allowlist — proxy, `HOME`, `PATH`,
    locale, CA certificates, container runtime — unless the self-hosted
    `exposeAllEnv` is set, which it is not. Every pin synchronizer reads a
    GitHub release, so without `RENOVATE_CUSTOM_ENV_VARIABLES` handing one a
    token they call `api.github.com` anonymously at 60 requests an hour from
    the runner's shared address, and a rate-limited lookup leaves the version
    bumped beside the previous release's digests. The build then fails at
    `sha256sum -c` rather than shipping the wrong binary, but delivery stops
    behind a pull request that looks correct. `LOG_LEVEL` is `debug`
    permanently for the same reason: Renovate logs post-upgrade compilation,
    execution, and which changes survived `fileFilters` only at debug.
14. The image loads its OMP settings overlay via `PI_CONFIG_FILES` in the image
    environment, the documented wrapper seam that lands in the CLI-overlay layer
    above user and project settings. The contributor cannot use `--config` at
    all, because Hive owns the `omp` argv inside its tmux session. The overlay
    sets `startup.checkUpdate: false`, since a read-only image cannot perform
    the `omp update` the banner advertises, and `symbolPreset: nerd`.
15. **Upstream Hive is never pinned**: the caller resolves Hive's tracking
    branch (`refs/heads/v4`) and passes the SHA as `--build-arg HIVE_COMMIT`;
    `just contribute-build` and both workflows do this. The build REQUIRES it
    and refuses a missing or malformed value — a build that resolved the branch
    itself could stamp the in-image commit file but not the label, shipping an
    image that cannot say what is inside it. The resolved SHA is stamped into
    `/usr/share/hive/contribute/HIVE_COMMIT`, labeled on the image
    (`io.hivecommons.contribute.hive.ref`), and recorded in the SBOM. The
    contract test compares the label against the in-image file.

## Pin maintenance

Upstream Hive tracks `v4` and is resolved at build time (never statically pinned).
OMP pins appear in `image/contribute/Containerfile`. `node scripts/update-omp-pins.mjs <version>`
reads the published GitHub release asset digests and updates the pins. Renovate runs
that command daily after changing `OMP_VERSION`, then automerges only after
repository checks pass. The merge triggers `publish-contribute.yml`; that workflow
builds and executes both native architectures before updating its published index.
Derived checksum automation for GitHub CLI, Node.js, tmux, and `requirements-ci.lock`
runs in their respective Renovate branches via `node scripts/update-gh-pins.mjs`,
`node scripts/update-node-pins.mjs`, `node scripts/update-tmux-pins.mjs`, and
`scripts/update-requirements-ci-hashes.mjs`.
The OMP, GitHub CLI, Node.js, and tmux synchronizers are configuration over one
shared implementation in `scripts/lib/release-pins.mjs`: change the pin-rewriting
or release-lookup behaviour there, not in four places.

## Verification

```bash
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
node --test tests/renovate-tracking.test.mjs
bash tests/contribute-contract.sh
git diff --check
```

With a container engine, build through `just contribute-build` and the
publish-contribute workflow's native build path.
