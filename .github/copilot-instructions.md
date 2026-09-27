# Copilot instructions for `contribute`

## Read the local contract first

Before changing this repository, read `AGENTS.md`, then
`docs/factory/agentic-model.md`, `docs/SKILL.md`, and the one task-specific
file under `docs/skills/`. Read `docs/skills/contribution-culture.md` alongside
every task-specific skill. The local launcher, image, tests, and documentation
must describe the same authority model.

Use session history, issue reports, and prior agent output only to find a
relevant source. Before asserting a repository-specific command, workflow, or
runtime behavior, verify it in the current launcher, image, test, workflow, or
local contract.

`contribute` ships one OCI image and the root `bin/hive-contribute` launcher (with a thin `justfile` wrapper):
the OMP contributor runtime (`image/contribute/Containerfile` -> `ghcr.io/projectbluefin/contribute`, used as a container registry location).
`tests/` contains contract tests (`tests/launcher-contract.sh`, `tests/contribute-contract.sh`, and pin/version tests).
The root `package.json` only pins the contributor relay's `ws` dependency; this is not a Node application.

## Route an operational request to the right command

| User goal | Command | Authority and lifecycle |
| --- | --- | --- |
| Run the Hive contributor worker | `hive-contribute` or `just contribute` | Foreground OMP worker; prefers a libkrun microVM with standard Podman fallback. Hive selects and assigns tasks. |
| Choose which hives to contribute to | `hive-contribute hives` or `just hives` | Attended picker over upstream `hivectl hives`; applies to running workers via staged registration + `USR1`. The contributor picks hives; Hive still picks tasks. |
| Change which followed hive is asked first | `hive-contribute switch [name]` or `just switch` | `hivectl hives use`; applies to running workers. |
| Perform attended Hive registration | `hive-contribute setup` or `just setup` | Attended Hive registration through upstream setup. |
| Diagnose launch readiness | `hive-contribute doctor` or `just doctor` | Read-only preflight; starts no agent. |
| Print appliance configuration | `hive-contribute config` or `just config` | Reads the single config file `${XDG_CONFIG_HOME:-~/.config}/hive-contribute.yml`. |
| Build the contributor image | `just contribute-build [tag]` | Produces the contributor OCI image. |

Never make task selection, assignment, completion, or priority decisions for
Hive.

## Upstream Hive is never pinned

Nothing in this repository pins Hive components (`contributor-agent.sh`, `contributor-relay.js`,
`pi-backend.js`, `lib/pane-classifier.js`, `backends.conf`, `gh-wrapper.sh`,
`restrictions/contributor-default.json`).
Every image build resolves the upstream `v5` tracking branch, stamps the commit into
`/usr/share/hive/contribute/HIVE_COMMIT`, records it in labels (`io.hivecommons.contribute.hive.ref`),
and documents it in the SBOM. `hive-contribute setup` clones the same branch.

Third-party release binaries (OMP, Node.js, GitHub CLI, tmux) remain digest-pinned.

## Defer model choice to OMP

Nothing in this repository pins, maps, filters, or selects a model or a
thinking effort — not the shipped appliance, not `.omp/config.yml`, not a
companion agent definition. The person at the client chooses the interactive
model and the effort that every spawned agent inherits. Adding a model name
back to a committed file overrides that choice for everyone who checks the
repository out.

## Follow upstream releases and derived checksums

The daily Renovate workflow tracks stable upstream releases (OMP, GitHub CLI,
Node.js, and tmux) along with PyPI dependencies in `requirements-ci.lock`.
Allowlisted tasks (`scripts/update-omp-pins.mjs`, `scripts/update-gh-pins.mjs`,
`scripts/update-node-pins.mjs`, `scripts/update-tmux-pins.mjs`, and
`scripts/update-requirements-ci-hashes.mjs`) synchronize version pins and verified
per-architecture digests across Containerfiles and lockfile hashes.
After checks and OMP-specific automerge, the `main` push triggers the image
publish workflow.

## Inspect live state; preserve active work

Before diagnosing or remediating a running appliance, inspect its live
container state, process tree, mounts, and recent logs. Treat attended OMP
or contributor sessions as user-owned: a pull or rebuild affects only future
launches. Keep interactive runs foreground and signal-responsive; never stop,
restart, kill, or reclaim an active attended instance to clear stale state.

Local appliance launches prefer Podman's `krun` OCI runtime. Missing KVM
prerequisites warn and run standard Podman containers.
Each invocation has a unique container name; never restore fixed names or `--replace`.

## Keep launcher mutations explicit and credential-safe

Pass secrets only through inherited environment variables or the documented
restricted mounts. Do not put credential values in arguments, logs, committed
files, Podman endpoints, socket paths, SSH targets, host-home
mounts, or static state. Preserve `--userns keep-id` for rootless Podman
access to the `0600` Hive contributor credential; never loosen that file's
permissions as a workaround.

## Validate by changed surface

Run the smallest existing contract test that covers the change:

| Changed surface | Focused validation |
| --- | --- |
| Launcher / CLI | `just --list`, `just doctor`, `bash tests/launcher-contract.sh` |
| Contributor image | `bash tests/contribute-contract.sh` |
| Skill frontmatter or catalog | `bash scripts/check-skill-frontmatter.sh`; use `--write` only to regenerate the index |

Finish changes with `git diff --check`.
