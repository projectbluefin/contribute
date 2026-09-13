---
name: launcher
version: "3.10"
last_updated: 2026-09-13
id: launcher
one_line_purpose: Change review just recipes without breaking the launch contract.
entry_point: docs/skills/launcher.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [just, launcher, podman, container, kubernetes]
description: "Maintains the review launcher recipes and their credential boundaries. Use when editing justfile."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en, /websites/kubernetes_io]
---

# Launcher

> The published image derives from the pinned lab-runner base and includes the
> contributor worker and maintainer dashboard. These procedures describe the
> launcher handoff and lifecycle for both modes.

## When to Use

Load this before editing `justfile` or changing container launch,
lifecycle, or credential-passthrough behavior.

## When Not to Use

Do not use this for Hive task selection, contributor-session triage,
or image-layer pinning. Those belong to the Hive or image build skill documents.

## Core Process

1. Document and maintain the public recipes and their purposes:

   | Recipe | Purpose |
   |---|---|
   | `contribute` | Start a foreground Hive contributor worker. |
   | `review-appliance` | Run the distroless Bluefin Review appliance container. |
   | `review-appliance-build` | Build the review appliance image locally and verify its contract. |
   | `review-container` | Run the Hive contributor worker: receive assigned tasks and donate inference. Foreground only; Ctrl-C stops it. |
   | `review-doctor` | Perform read-only preflight diagnostics for this machine. Starts no agent. |
   | `review-queue` | Open the maintainer review dashboard over the Bluefin PR queue. |
   | `review-stop` | Stop cluster contributor workers; refuses attended runs and unlabeled containers. |
   `just` reads only this directory's justfile; use a `~/.local/bin` shim elsewhere.

2. Interactive paths stay foreground; Ctrl-C stops them. Detached contributor
   containers are not supported; `REVIEW_DETACH=1` is rejected. Cluster workers
   run in Kubernetes and stop with `just review-stop cluster` (or `just review-stop`).
   The launcher owns its Hive checkout and Podman dashboard state. An attended
   contributor run starts a passive Textual worker-status companion after Hive
   has created `contributor`. It reads only the authenticated `/api/v1/status`,
   `/api/v1/me`, and `/api/v1/contributors` endpoints, refreshes in-process
   with one bounded in-flight read, and shows the exact command
   `podman exec -it <container> tmux attach -t contributor`. It never selects,
   injects, captures, or retries assignments; it never restarts or completes
   work. The image-owned `/opt/bluefin/config/display-brand` file supplies the
   display name shared by the dashboard and worker companion; a missing file
   uses the generic `Review` fallback and does not affect routing or access.
3. Mount only read-only Hive contributor configuration. `review-queue` gets
   an optional TLS `HIVE_HUB` URL, mounts
   `${XDG_STATE_HOME:-~/.local/state}/bluefin-review` with shared `rw,z`, and
   passes `BLUEFIN_REVIEW_INSTANCE`; `REVIEW_HIVE` selects a named registration.
4. Codex is the backend for `review-container` (`TOOL=codex`, only valid tool
   value). For `review-queue`, OMP is the default backend and Codex is the
   explicit alternate backend (`BLUEFIN_REVIEW_BACKEND=codex`). Model profiles
   set `AGENT_MODEL` and `AGENT_REASONING_EFFORT` (profiles: `gemini`, `sol`,
   `opus5`, `k3`). Environment variables always take precedence.
5. Keep `COPILOT_INTEGRATION_ID=copilot-developer-cli` exported; `bin/omp-review`
   pins it. Copilot gates its catalog on that header, so dropping it 400s the
   `/models` request and takes every Gemini, Claude, GPT and Kimi id out of the
   picker at once. OMP names the casualties `header_omitted_model_ids`.
6. Pass credentials via inherited environment, never CLI args; stage Codex auth at `0600`.
7. When renaming launcher identifiers, do a full sweep and leave no aliases.

## Container Ownership

`podman run --rm -it` does **not** bind a container's lifetime to its client:
`conmon` can leave a running ownerless container after a hard-killed terminal.
Prove ownership with `review.owner=<boot-id>:<client-pid>` only when that PID
is live, from the same boot, and still names the container; never infer it
from `pgrep`. Reclaim other containers as orphans. Attended containers are
user-owned: pulling or rebuilding an image affects only future launches.

## Concurrent Instances

Every ownership check is keyed on the container name. `REVIEW_CONTAINER_NAME`
overrides the default `review-container` and is the only supported way to run a
second contributor agent concurrently (`REVIEW_CONTAINER_NAME=review-2 just review-container opus5 high`).
Keep it to that one variable without adding instance managers or registries.
Validate user-supplied names against `[a-zA-Z0-9][a-zA-Z0-9_.-]*` before
launch. Hive selects tasks; the launcher never filters or skips assignments.

## Cluster Contributor Scale-Out

`just review-container cluster [N]` scales out unattended contributor workers
across Kubernetes. It is always an explicit choice: no dashboard recipe starts a
worker. See [`cluster-workers.md`](cluster-workers.md) for secrets and
orchestration.

## Kubernetes Dashboard Sessions

`REVIEW_RUNTIME=k8s just review-queue` runs a foreground dashboard Pod with its dedicated state claim (`deploy/review-queue-state.yaml`). Unreachable cluster falls back to Podman; missing claim stops before Secret or Pod creation. Pod uses `imagePullPolicy: Always` and removes itself on exit. Optional countme remains local to the session Secret.
## Rootless Podman And Mounted Host Files

Rootless Podman maps the host user to container **root**, not to the container
user of the same uid. A mounted host file keeps its mode, so Hive's
`contributor.env` at `0600` arrives root-owned and the image's `dev` user
cannot read it — the agent dies at startup with `Permission denied` before any
work begins. Launch with `--userns keep-id:uid=1000,gid=1000` so the host user
maps onto `dev`. Never answer this by loosening the host file's mode; it holds
Hive credentials.

Podman remote connection setup is machine-local operator state (`podman system
connection`, `containers.conf`, or user environment). Never put
`CONTAINER_HOST`, endpoint, SSH target, socket, or credential config in the
repository. When an existing local Podman connection is default, builds,
pulls, and recipe runs execute on that service transparently.

`review-queue` resolves engines in order: `CONTAINER_HOST`, `CONTAINER_CONNECTION`, then saved default. Remote engines fail closed unless `REVIEW_QUEUE_ALLOW_REMOTE_STATE=1`. An SSH-backed connection stages `0600` Hive credentials to a private `0700` remote directory and removes it on exit without altering remote canonical configs.

A locally built image has no registry behind it and is not a moving tag.
Build local images under the `sha-<commit>` tag CI mints for that commit.
Absent from local storage is the final answer for a `localhost/` ref:
fail immediately rather than attempting remote registry dials.

## The Optional Lab

A maintainer may lend one `review-queue` session their own Kubernetes cluster
(#379). A host broker on `scripts/review-lab-broker.py` provides a private
Unix socket (`--runtime-flag=host-uds=open` under gVisor `runsc`). No
kubeconfig or credentials enter the container. See [`lab-broker.md`](lab-broker.md)
for full broker details. This is distinct from `REVIEW_RUNTIME=k8s`: the lab
broker is offered only to the local Podman dashboard.

- An alias or undocumented public recipe, or a detached/background contributor run.
- Altering remote canonical configuration during staging or broad deletion on cleanup.
- Host directory mounts beyond read-only Hive config or host Codex config/login instead of staged auth.
- Tokens in output, files, args, or persisted launcher state.
- Ownership inferred from `pgrep` rather than a live, same-boot PID label.
- Remote connection settings or endpoints committed to repository files.
## Red Flags

- An undocumented public recipe, or a detached/background contributor launch.
- Altering a remote canonical configuration directory or file during remote staging,
  or broad deletion on cleanup.
- An interactive launch path whose final process is neither `exec`'d nor the last
  foreground command whose status propagates (`nohup`, `setsid`); background jobs
  the shell `wait`s on and reaps by trap are allowed, for signals.
- A host directory mount beyond the read-only Hive configuration for the contributor
  container, or a host Codex config/login mount instead of the staged auth file.
- Unsetting or overriding `COPILOT_INTEGRATION_ID` on a launch path.
- A token in output, files, Podman arguments, or any persisted launcher file.
- Ownership inferred from `pgrep` rather than a label plus a live, same-boot,
  still-naming PID.
- A user-supplied container name reaching `podman run` or an ownership probe
  unvalidated, or a hint that names the default container instead of the one
  the caller asked for.
- Stopping or restarting an active attended container because an image was
  pulled or rebuilt.
- A repository-committed `CONTAINER_HOST`, endpoint, SSH target, socket path,
  or connection credential.
- A Kubernetes dashboard session without the dedicated state claim, foreground
  attach, or Pod-and-Secret cleanup.
- Countme configuration outside the local Kubernetes session-secret handoff.
- A model-catalog or model-ID validity check in the launcher; only the profile
  name is a closed set.
- Contributor task-selection policy outside Hive (own-work exclusion on the
  maintainer queue view is the one permitted filter).

## Verification

```bash
just --list
just review-doctor
bash tests/just-onboarding.sh
git diff --check
```

The recipe list must match the documented public recipes. Doctor must not start a container.

`just contribute [gemini|luna|opus5|sol]` starts the isolated OMP worker. It mounts one selected Hive registration at `/home/bluefin/.config/hive/contributor.env`, passes provider credentials only by inherited environment names, and uses `--userns keep-id:uid=65532,gid=65532`; `review-container` remains on the compatibility image.

## Sources

- Podman environment inheritance: Context7 `/websites/podman_io_en`

## Minimal Linux hosts

Both packaged launchers suppress Apptainer's default `/etc/localtime` and
`/etc/hosts` binds only when the corresponding host path is absent, including
a dangling symlink. Existing files and explicit configuration binds remain in
place. A missing destination inside the SIF is a separate Apptainer warning.
The personal Brew package supplies `squashfuse` for direct SIF mounting.
Room's documented privileged devcontainer configuration exposes `/dev/fuse`;
validate the actual direct-mount path when testing minimal-host compatibility.
