---
name: launcher
version: "5.1"
last_updated: 2026-09-14
id: launcher
one_line_purpose: Change review just recipes without breaking the launch contract.
entry_point: docs/skills/launcher.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [just, launcher, podman, kubernetes, omp, hive]
description: "Maintains the OMP appliance and Hive contributor launcher recipes without crossing their credential or authority boundaries."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en, /websites/kubernetes_io]
---

# Launcher

## Public commands

| Recipe | Purpose |
| --- | --- |
| `review-queue [flags...]` | Convenience alias for `review-appliance`; opens one isolated OMP review appliance. |
| `review-appliance [flags...]` | Runs `ghcr.io/projectbluefin/review`, preferring Podman `krun` and falling back to Apptainer. |
| `review-appliance-build [tag]` | Builds and verifies the review image locally. |
| `review-container [instance]` / `contribute [instance]` | Same Hive-authorized OMP worker; an optional instance selects its named Hive registration. |
| `contribute cluster [N]` | Scales independent Hive + OMP workers. |
| `review-stop [cluster]` | Stops cluster workers; local appliances stop with their terminal. |
| `review-doctor` | Read-only preflight; starts no agent. |

`review-queue` must remain delegation, not a second implementation. It and
`review-appliance` use the same image, entrypoint, OMP configuration, extension,
state volume, credentials, and argument parser.

## Authority boundary

The maintainer workbench reads live GitHub state and optional Hive ordering. It
does not register as a Hive contributor and does not select or complete Hive
assignments.

The contributor image contains Hive's worker runtime only. Hive chooses the
task, injects the prompt, owns the `contributor` tmux session, and captures the
result. The entrypoint may validate credentials and attach the terminal; it
must not filter, reorder, retry, or interpret assignments.

## Isolation and lifecycle

Every packaged appliance command prefers `podman run --runtime=krun` when
Podman, `krun`, and `/dev/kvm` are available. Otherwise it reports the missing
prerequisite and falls back to isolated Apptainer execution. Container names
include the target and a per-process suffix, so simultaneous KVM invocations
cannot replace one another. Persistent OMP homes are target-specific;
`BLUEFIN_INSTANCE` explicitly separates two sessions for the same target.

Every interactive microVM stays attached to its launching terminal. Do not add
`--detach`, `-d`, `nohup`, `setsid`, systemd units, or resurrection commands.
Ctrl-C stops only that invocation. `review-stop cluster` is reserved for the
Kubernetes worker deployment.

## Credentials

- Pass secrets only through inherited environment names or documented private
  mounts. Never put values in arguments, logs, image layers, socket paths, SSH
  targets, or committed files.
- Preserve `--userns keep-id` for the `0600` contributor registration.
- The OMP appliance receives GitHub/provider credentials by inherited name.
- Apptainer's contained environment receives only the explicit credential and
  runtime allowlist through `APPTAINERENV_` variables. Keep `--no-eval` so
  credential and argument values remain literal inside the container.
- The contributor worker receives exactly one selected Hive registration.
- The checkout contributor recipe stages remote Podman registrations privately
  and deletes only its validated staging directory. The packaged `bluefin`
  launcher uses local Apptainer when Podman selects a remote engine; it never
  sends client-side credential bind paths to that engine.

## Arguments

`scripts/parse-review-args.sh` is the single parser for OMP review scope.
Repository, `--pr`, and `--issues` arguments must reach the appliance unchanged.
The optional contributor argument names an isolated instance and its
`contributor.<org-repo>.env`; Hive still selects work. OMP owns model choice.

## Verification

```bash
just --list
just --dry-run review-queue --issues
bash tests/just-onboarding.sh
bash tests/appliance-contract.sh
git diff --check
```
