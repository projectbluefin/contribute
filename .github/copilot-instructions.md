# Copilot instructions for `review`

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

`review` ships two OCI images and the root `justfile` launcher: the distroless
OMP review appliance (`image/appliance/Containerfile` ->
`ghcr.io/projectbluefin/review`) and the OMP contributor runtime
(`image/contribute/Containerfile` -> `ghcr.io/projectbluefin/contribute`).
`image/extension/bluefin-review/` is the OMP review mode, loaded from source by
OMP and gated by `tests/omp-review-mode.sh`; `tests/` contains shell, Python,
and Node contract tests. The root `package.json` only pins the contributor
relay's `ws` dependency; this is not a Node application.

## Route an operational request to the right command

| User goal | Command | Authority and lifecycle |
| --- | --- | --- |
| Contribute one local Hive worker | `bluefin contribute [instance]` or `just contribute [instance]` | Foreground OMP worker; prefers a libkrun microVM and falls back to Apptainer. Hive selects and assigns tasks. |
| Scale cluster contributors | `just contribute cluster [N]` | OMP workers independent from the maintainer workbench. |
| Review PRs or implement issues | `bluefin review [org/repo]` or `just review-queue [flags...]` | Foreground OMP workbench; prefers a libkrun microVM and falls back to Apptainer. Issue mode implements selected issues into pull requests, while PR mode reviews, repairs, and lands selected pull requests. |
| Develop the review extension directly | `bin/omp-review [number\|issues]` | Host OMP process; development-only, not an appliance boundary. |
| Build the review image | `just review-appliance-build [tag]` | Produces the OCI image used by both runtimes. |
| Stop cluster workers | `just review-stop cluster` | Explicit cluster lifecycle command. |
| Diagnose launch readiness | `just review-doctor` | Read-only preflight; starts no agent. |

Never make task selection, assignment, completion, or priority decisions for
Hive. The maintainer owns review, approval, queueing, and merge decisions; an
explicit Slay action delegates its bounded implementation, review, repair,
and landing lifecycle to the workbench coordinator.

The review mode consumes Hive rather than competing with it. Pull requests
authored by the authenticated user with requested changes form a local,
repair-only lane first; they are never self-reviewed, approved, or merged.
When a hub is configured, the remaining queue keeps Hive's positions exactly.
Without a hub, the dashboard classifies live GitHub evidence as
`repair-requested`, `ready-for-human-merge`, `review`, `resolve-conflicts`,
`fix-ci`, `investigate`, or `triage`. Local repair ordering never changes Hive
priority or contributor assignment.

## Defer model choice to OMP

The shipped appliances do not pin, map, filter, or select models or thinking
effort. The user chooses both through their active OMP configuration. Shipped
companion agents omit model and effort fields and inherit OMP's resolved choice.

For repository development, `.omp/config.yml` pins subagent models and effort
and defines model-role mappings. It leaves the interactive model to the user
and is not copied into either runtime image.

## Follow upstream releases and derived checksums

The daily Renovate workflow tracks stable upstream releases (OMP, GitHub CLI,
Node.js, and tmux) along with PyPI dependencies in `requirements-ci.lock`.
Allowlisted tasks (`scripts/update-omp-pins.mjs`, `scripts/update-gh-pins.mjs`,
`scripts/update-node-pins.mjs`, `scripts/update-tmux-pins.mjs`, and
`scripts/update-requirements-ci-hashes.mjs`) synchronize version pins and verified
per-architecture digests across Containerfiles and lockfile hashes.
After checks and OMP-specific automerge, the `main` push triggers both image
publish workflows. Never update only one image or a version without its release
asset digests.

## Inspect live state; preserve active work

The queue is live GitHub/Hive evidence. Inspect it through the active appliance,
GitHub, or Hive. OMP's state volume records session and batch recovery; never
substitute a static queue snapshot for current upstream state.

Before diagnosing or remediating a running appliance, inspect its live
container/Pod state, process tree, mounts, and recent logs. Treat attended OMP
or contributor sessions as user-owned: a pull or rebuild affects only future
launches. Keep interactive runs foreground and signal-responsive; never stop,
restart, kill, or reclaim an active attended instance to clear stale state.

Local appliance launches prefer Podman's `krun` OCI runtime. Missing KVM
prerequisites must produce an explicit warning before falling back to Apptainer.
Each invocation has a unique container name and target-specific state; never
restore fixed names or `--replace`.

## Keep launcher mutations explicit and credential-safe

For cluster scale-out changes, validate the resolved `HIVE_HUB` and selected
credentials before the first Kubernetes mutation. Preserve the launcher's
non-blocking fallback when Kubernetes is unavailable, but propagate failures
from secret synchronization, legacy-annotation removal, and scale operations
with actionable errors rather than masking them.

Pass secrets only through inherited environment variables or the documented
restricted mounts. Do not put credential values in arguments, logs, committed
files, Podman endpoints, socket paths, SSH targets, kubeconfigs, host-home
mounts, or static state. Preserve `--userns keep-id` for rootless Podman
access to the `0600` Hive contributor credential; never loosen that file's
permissions as a workaround.

## Validate by changed surface

Run the smallest existing contract test that covers the change:

| Changed surface | Focused validation |
| --- | --- |
| Root launcher or cluster handoff | `just --list`, `just review-doctor`, `bash tests/just-onboarding.sh` |
| OMP review mode | `bash tests/omp-review-mode.sh` |
| Review appliance | `bash tests/appliance-contract.sh`; with an engine, `just review-appliance-build` |
| Contributor image | `bash tests/contribute-contract.sh` |
| Skill frontmatter or catalog | `bash scripts/check-skill-frontmatter.sh`; use `--write` only to regenerate the index |

Launcher tests are hermetic: fake external tools and assert exact commands or
observable behavior. Do not allow a missing-tool scenario to fall through to a
host `kubectl`, Podman service, cluster, or credential. For broad hygiene, run
`pre-commit run --all-files`, which includes ShellCheck via the
shellcheck-py wheel (no container pull). Finish changes
with `git diff --check`.
