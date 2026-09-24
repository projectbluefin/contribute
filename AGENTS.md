# hive-contribute — Agent Operating Contract

`contribute` is the repository for the **hive-contribute** appliance: upstream Hive's contributor runtime packaged as an isolated distroless container image, driven by OMP.
The contributor product runs via `bin/hive-contribute` (or `just contribute`).
Hive owns its contributor protocol, task selection, tmux session, prompt injection, and output capture.
OMP owns agent execution, sessions, tasks, model choice, thinking effort, and tool boundaries.

## Read order

1. This file.
2. [`docs/factory/agentic-model.md`](docs/factory/agentic-model.md).
3. [`docs/SKILL.md`](docs/SKILL.md).
4. The one matching file in `docs/skills/`.

## Boundaries

Keep this repository focused: it ships the `hive-contribute` appliance.

### Product boundary

- **OMP** provides sessions, agents, execution, model choice, and tool boundaries.
- **Hive** owns task selection, assignment, prompt injection, the `contributor`
  tmux session, and output capture. Hive assigns work; the contributor worker
  implements only its assigned scope.

The interactive commands run the image runtime in the foreground of the
terminal that launched them, and Ctrl-C stops them. Detached contributor
containers are not supported. No launch path may
background a container run — no `nohup`, no unlabeled `podman run -d`,
and no job that silently outlives the terminal.

Every local contribution launch uses Podman (preferring Podman's `krun` OCI runtime
when KVM is available). Container invocations get unique container names with
persistent OMP state keyed by a hash of the hub endpoint, keeping separate hives isolated.
Hive is the sole authority for selecting and assigning contributor tasks: do
not skip, reorder, prioritize, or decline a Hive assignment mid-protocol.

### Upstream Hive Tracking (Never Pinned)

Hive's contributor runtime components (`contributor-agent.sh`, `contributor-relay.js`,
`pi-backend.js`, `lib/pane-classifier.js`, `backends.conf`, `gh-wrapper.sh`, and
`restrictions/contributor-default.json`)
are **never pinned** to a static commit. The image build fetches them from upstream's
tracking branch (`v4`), resolves the branch commit SHA at build time, and stamps that SHA into:
- `/usr/share/hive/contribute/HIVE_COMMIT`
- Image label `io.hivecommons.contribute.hive.ref`
- The build SBOM at `/usr/share/hive/contribute/sbom.spdx.json`

The launcher's `setup` subcommand clones that same tracking branch, so registration and runtime follow one release line. They are not the same commit — `setup` reads `v4` live, the image carries the SHA resolved at its last build — so the gap is bounded by the daily rebuild, not zero.
Third-party release binaries (OMP, Node.js, GitHub CLI, tmux) remain digest-pinned and
updated automatically by Renovate.

The work the appliance produces for other repositories is toil reduction for
under-maintained projects, not feature work: agents repair what is broken and
finish what a project already decided to do, and size every change to be
reviewable by a tired maintainer. When a task can only be completed by
out-of-scope work, an evidenced written finding is the deliverable. See
[`docs/skills/contribution-culture.md`](docs/skills/contribution-culture.md).

Grandfathering is an antipattern here. Do not record a known-wrong thing as an
accepted exception and move on: fix it now, or delete it. Reject the words
*grandfathered*, *sanctioned*, *legacy exception*, *pre-existing*, *for now*,
and *temporarily* in this repository's documents.

A gap is filed, not documented. When something is broken or missing — here, in
the base image, or upstream — open an issue and reference it by number. Do not
write a section explaining it. See [`docs/skills/upstream-hive.md`](docs/skills/upstream-hive.md).

## Repository layout

- `bin/hive-contribute` is THE primary launcher executable (subcommands: `run`, `doctor`, `setup`, `config`).
- `justfile` is a thin wrapper calling `bin/hive-contribute`.
- `image/contribute/` builds the OMP contributor image (`ghcr.io/projectbluefin/contribute`, used as a registry location).
- `package.json` and `package-lock.json` pin only the contributor relay's `ws`
  dependency. This repository is not a Node application.
- `scripts/` contains build-time generators and documentation checks.
- `tests/` contains launcher and contributor contracts (`tests/launcher-contract.sh`, `tests/contribute-contract.sh`).
- `docs/` contains the skill router and catalog.

## Permitted changes

Local repository contracts take precedence. Treat the rules in this file as binding.

## PR rules

- PR titles follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `style:`, `refactor:`, `perf:`, `test:`, `ci:`, `build:`, `revert:`), enforced
  by the required `conventional-title` check. The type must be the first token
  in the title — any prefix before it fails the check. The description is
  free-form, so trailing annotations are fine. This repository squash-merges, so
  the PR title becomes the permanent commit subject.

## Context sources

- Upstream Hive repository: `https://github.com/hivecommons/hive`
- External API details: Context7 documentation.
