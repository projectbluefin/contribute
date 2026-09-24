---
name: launcher
version: "5.6"
last_updated: "2026-09-24"
id: launcher
one_line_purpose: Change the hive-contribute launcher without breaking its runtime contracts.
entry_point: docs/skills/launcher.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [just, launcher, podman, omp, hive]
description: "Maintains the hive-contribute appliance and launcher recipes without crossing credential or authority boundaries."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en]
---

# Launcher

## Public commands

The primary launcher executable is `bin/hive-contribute`:

| Command | Purpose |
| --- | --- |
| `hive-contribute` / `hive-contribute run` | Runs the Hive-authorized OMP worker in the foreground. |
| `hive-contribute setup` | Performs attended Hive registration through upstream Hive's setup. |
| `hive-contribute doctor` | Read-only preflight diagnostics; starts no agent and exports no credential. |
| `hive-contribute config` | Prints the resolved appliance configuration from the single config file. |

The `just contribute`, `just doctor`, `just setup`, `just config`, and `just contribute-build`
recipes are thin wrappers around `bin/hive-contribute`.

## Configuration: One File

All configuration lives in `${XDG_CONFIG_HOME:-~/.config}/hive-contribute.yml`.
The file has nine flat keys: `hub`, `registration`, `image`, `backend`, `memory`, `cpus`, `llmman`, `llmman_token`, and `llmman_model`.
`memory` and `cpus` carry upstream's contributor workload envelope (4 GiB, 2 CPUs), with
swap pinned to the memory ceiling; `none` or `0` removes a ceiling.
The three `llmman` keys default to empty, which is what keeps local inference off.
The launcher creates the file on first run, seeding `hub` from an existing
`~/.config/hive/contributor.env` if present. Setting `HIVE_CONTRIBUTE_CONFIG` points to an
alternate configuration file.

Under WSL2, keep `registration:` on the Linux filesystem (such as `~/.config/hive/contributor.env`), never on a Windows drive mount (`/mnt/c/...`). Windows DrvFs mounts do not preserve Linux file modes (`0600`) without explicit metadata configuration, silently exposing the contributor registration credential.

## Supported platforms

`hive-contribute` requires a Linux host environment. Both isolation tiers (KVM microVMs via `krun` and standard Podman rootless containers) depend on Linux kernel facilities (`/dev/kvm` and unprivileged user namespaces).

- **Linux**: Supported natively (Podman with `/dev/kvm` and `krun` for hardware isolation, or standard rootless Podman containers).
- **macOS**: Requires a Linux VM. Provision with Lima (`limactl start`). Run the launcher inside the guest VM.
- **Windows**: Requires a Linux VM via WSL2. Provision with `wsl --install`. Run the launcher inside the WSL2 Linux distribution.

When launched on a non-Linux host, `hive-contribute doctor` and `run` fail with a diagnostic naming the platform requirement ("this appliance requires a Linux host; on macOS use Lima, on Windows use WSL2") instead of container errors.

## Authority boundary

The contributor image contains Hive's worker runtime and OMP. Hive chooses the
task, injects the prompt, owns the `contributor` tmux session, and captures the
result. The entrypoint may validate credentials and attach the terminal; it
must not filter, reorder, retry, or interpret assignments.

OMP owns agent execution, model choice, thinking effort, and tool boundaries.

## Isolation and lifecycle

Every worker invocation prefers `podman run --runtime=krun` when
Podman, `krun`, and `/dev/kvm` are available. When KVM is unavailable, it
warns and runs standard Podman containers.
Container names include an instance slug derived from the hub URL and a per-process suffix.
Persistent OMP homes are target-specific based on the hub hash.

Every interactive container stays attached to its launching terminal in the foreground.
Detached containers are not supported. Ctrl-C stops only that invocation.
Before launch, mutable image tags are refreshed. A local cached copy is used with a warning
if registry connectivity fails.

## Credentials

- Pass secrets only through inherited environment names or documented private
  mounts. Never put values in arguments, logs, image layers, socket paths, SSH
  targets, or committed files.
- Preserve `--userns keep-id:uid=65532,gid=65532` for the `0600` contributor registration. Under WSL2, keep this file on the Linux filesystem to ensure the `0600` mode is preserved.
- The forwarded provider-credential allowlist names GitHub, Copilot, Anthropic,
  OpenAI, OpenRouter, Gemini, Google, and terminal variables, plus the Amazon Bedrock
  credentials `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`, and `AWS_DEFAULT_REGION`.
  Only those reach the contained process; host `~/.config/gh` is never mounted.
  Inside the container that GitHub token is held by Hive's own `gh` wrapper, which
  refuses `gh auth`, every mutating `gh api`, and every subcommand outside its
  allowlist — so forwarding a token is not the same as handing an assigned task
  free rein over the account it belongs to.
- `HIVE_SESSION` is forwarded whenever it is SET, including when it is empty:
  an explicit empty value is the relay's documented opt-out of session labeling,
  while leaving it unset lets the relay default the label to the backend name.
- The contributor worker receives exactly one selected Hive registration mounted read-only
  at `/home/hive/.config/hive/contributor.env:ro`.
- A registration token is rotated by the hub, and only the hub can say whether a
  stored one is still accepted. This launcher does not ask: it mounts the
  credential and lets Hive's relay authenticate. A rejected token surfaces as
  the relay's own failure, and the repair is upstream's `contribute-move`, not
  anything here. Do not add a downstream validator, reissue call, or relaunch
  loop — that is Hive's protocol, and a second implementation of it drifts the
  moment upstream changes a message.

## Local inference (llmman)

Selecting a local endpoint is the operator's act, never a default and never
inferred: with `llmman` empty the launch argv is what it has always been.
When it is set:

- A loopback endpoint gets `--network slirp4netns:allow_host_loopback=true`
  and is rewritten to `10.0.2.2` for the container; a routable one is passed
  through unchanged and gets no network mode of its own. Note that
  `allow_host_loopback=true` exposes the host's entire loopback interface
  (`127.0.0.1`) to the worker at `10.0.2.2`, not only the llmman port. Do not
  publish a port, share the host network namespace, or start a listener.
  Peer aggregation is llmman's own feature, configured in llmman.
- `OPENAI_BASE_URL` crosses by value (an address, and an auditable one);
  `OPENAI_API_KEY` crosses by name, holding the contents of `llmman_token`.
  With no `llmman_token` the appliance sends its own placeholder rather than
  the operator's cloud OpenAI key. The cloud OpenAI slot is repurposed for the
  local endpoint while other configured cloud providers remain available.
- `doctor` owns verification — endpoint, transport, key, one read-only `GET`
  of the OpenAI-compatible model list, and whether `llmman_model` is loaded.
  `run` never probes the hub or the endpoint.
- When `llmman_model` is configured, it is passed into the appliance and
  configured as OMP's default model selection.

## Verification

```bash
hive-contribute doctor
just --list
bash tests/launcher-contract.sh
bash tests/contribute-contract.sh
git diff --check
```
