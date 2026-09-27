---
name: hive-runtime
version: "3.1"
last_updated: "2026-09-19"
id: hive-runtime
one_line_purpose: Operate inside Hive's tmux, token, and cooldown constraints.
entry_point: docs/skills/hive-runtime.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [hive, tmux, runtime, tokens, cooldown, workspace]
description: "Explains Hive's tmux session, workspace directory, prompt and output contract, contributor credentials, token lifetime, cooldown, and exclusive task selection. Use when operating or debugging a session."
metadata:
  type: reference
---

# Hive Runtime

> The contributor image contains the upstream Hive relay and OMP. These
> procedures describe its handoff from the launcher.

## When to Use

Load this before changing code near a Hive session boundary or when an
assigned contributor session behaves unexpectedly.

## When Not to Use

Do not use this to diagnose a specific stuck or missing assignment — that is
[`hive-triage.md`](hive-triage.md) — or to report a finding upstream, which is
[`upstream-hive.md`](upstream-hive.md). Do not use it for the launcher's own
credential handling ([`launcher.md`](launcher.md)).

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "A local shim will unblock this now." | It outlives the gap it was written for and shadows the real tool once upstream lands the fix. Report it and wait. |
| "Upstream is slow; we can patch our copy." | The appliance carries upstream's files directly; do not fork or patch them. |
| "We should pin Hive to a known commit." | The runtime is tracked from upstream's `v5` branch, not pinned to a static commit. Setup and runtime follow one release line; they are not the same commit, since setup reads `v5` live while the image carries the SHA resolved at its last build. |

## Core Process

1. Let Hive own the WebSocket protocol, assignment selection, `contributor`
   tmux session, prompt injection, and result capture. Context7 reaches the
   agent through Hive's server-side knowledge export. `hive-contribute`
   launches the OMP-only runtime; the launcher does not choose a model or
   implement Hive's jobs.
2. Attach only to inspect or deliberately steer a live session:

   ```bash
   podman exec -it <container> tmux attach -t contributor
   ```

   Detaching tmux changes the display, not the run. Ctrl-C or
   closing the original terminal ends the contributor.
3. Expect the agent to start in Hive's prepared workspace. `contributor-agent.sh`
   exports `HIVE_WORKSPACE_DIR` (default `$HOME/workspace`), creates it, and
   starts the tmux session rooted there with `tmux new-session -c`. Clone
   assigned work into that directory; no `cd` step is required, and the
   launcher must not create or mount a workspace of its own.
4. Put the final result in the final 15 pane lines. Hive captures only those
   lines for its report.
5. Plan around the scoped assignment token's 55-minute lifetime. The hub
   proactively re-mints and pushes a fresh token to an active task after 50
   minutes, so a long task survives expiry only while its socket stays up.
   Report completion only after its verifiable artifact exists: a completion
   carrying a PR link applies the 168-hour issue cooldown, a completion with
   no PR link only 4 hours, and a failure or disconnect books the short
   10-minute failure cooldown — 6 hours once an issue is quarantined.
6. Do not filter, decline, rank, or retry assignments in this repository.
   Hive selection is the sole authority. The relay's own negative-ack handling
   is Hive's, not ours: when the hub declines to assign work it sends
   `task_unavailable` with a reason, which the relay logs before re-asking
   30 seconds later. The reasons are defined by the *hub*, in
   `src/pkg/dashboard/contribute_ws.go`, not by the relay.
   Three are enforced refusals (`token_mint_failed`, `tier_disabled`,
   `concurrency_limit`), two are rate caps (`hourly_limit`, `daily_limit`),
   and three mean the hub simply has nothing to hand over right now
   (`contribution_suspended`, `hub_not_ready`, `no_matching_work`).
7. Treat the relay's protocol version and capability declaration as
   informational. The relay reports its runtime posture during authentication,
   and Hive stores and surfaces it without routing or gating assignments on it.
   Do not add downstream capability-based task selection.
8. Expect interactive delivery from `hive-contribute` (and `just contribute`).
   The runtime reads `CONTRIBUTOR_MODE`, which defaults to `interactive` (a live tmux
   pane the relay types the prompt into). This OMP contributor is interactive-only;
   it retains tmux probes and must not select headless mode until upstream proves
   equivalent one-shot semantics.

### Hive runtime contract

Hosted deployments serve under `hivecommons.dev`.
The public `/api/contribute` prefix exposes read-only status, queue,
events, activity, fleet, limits, and triage projections. Prefix
publicity does not make mutation handlers unauthenticated; those handlers
still enforce their own write requirements. Hive owns contributor admission
and ordered individual assignment. Downstream launchers must not reorder,
retry, assign, or become a second scheduler.

`ReadyQueue` is a display projection; assignment eligibility remains
`selectTask` policy. This pin exposes no assignment grouping, batching,
dependency, or relatedness signal. Do not infer one from triage or display
metadata. `max_concurrent` counts tasks held by contributor identities.
Issue-to-PR linkage is a best-effort GitHub search projection cached for about
90 seconds, not durable truth.

### GitHub identity

The contributor container passes one contributor GitHub token as inherited
`GH_TOKEN`; it does not mount the host GitHub configuration.
Never log or persist either credential.

`gh` inside the container is Hive's own `bin/gh-wrapper.sh`, installed as the
agent's `gh` with the real binary behind it at `/opt/hive/bin/gh-real`.
Contributor mode is the root-owned `/etc/hive/contributor-mode` marker, never an
environment variable, and in that mode the wrapper keeps the contributor's own
token (contributors fork and open PRs under their own identity), refuses the
`gh auth` subcommand, refuses every mutating `gh api`, denies any subcommand
outside its allowlist, and labels created issues and PRs `contributor/<login>`
and `cli/omp`. Read-only lookups stay allowed so an agent can check for an
existing PR before starting. Do not reimplement, relax, or shadow these gates.

To inspect earlier session output, enter tmux copy-mode with `Ctrl-b [`.
PageUp or the mouse wheel scrolls, tmux search finds text, and `q` returns to
the live pane. Copy-mode changes only your view; Hive still owns output
capture.

When configuring the contributor image, preserve the attach client's
recognized `TERM`; tmux's pane terminal is configured separately. Enable tmux
mouse support so the wheel enters copy-mode for long output. Do not alter
Hive's session creation to accomplish either behavior.

Give the image a UTF-8 locale that it actually ships (`LANG=C.UTF-8`). tmux
decides UTF-8 support from the client's `LANG`/`LC_ALL`/`LC_CTYPE` alone, so an
unset or uninstalled locale leaves the attached terminal in non-UTF-8 mode:
box drawing arrives as DEC ACS escapes and every other non-ASCII cell as `_`.

## Red Flags

- Creating or naming tmux sessions, injecting prompts, or scraping pane output
  in the launcher or image.
- Adding assignment selectors or client-side retry loops.
- Treating a tmux detach as background execution.
- Preparing, mounting, or renaming a contributor workspace in the launcher or
  image instead of using Hive's `HIVE_WORKSPACE_DIR`.
- Adding a local retry, poll, or timeout to compensate for a relay revision
  that ignores `task_unavailable`.
- Reporting completion before the required artifact is independently visible.
- Assuming an abruptly killed contributor strands its assigned task. The hub
  releases `currentTask` in its disconnect handler and books a cooldown.
- Mounting `~/.config/gh` or printing a token to provide agent identity.

## Verification

```bash
podman exec -it <container> tmux ls
podman exec -it <container> tmux attach -t contributor
bash tests/launcher-contract.sh
```

Confirm that `contributor` exists, the final pane lines contain the result,
and no launcher change duplicates Hive lifecycle behavior.

## Sources

- Relay message cases, including `task_unavailable`:
  `bin/contributor-relay.js`
- Workspace preparation and tmux rooting:
  `bin/contributor-agent.sh`
- Task release on disconnect:
  `src/pkg/dashboard/contribute_ws.go`
- tmux terminal and mouse configuration: Context7 `/tmux/tmux`
- Public contribute projections and assignment policy:
  `server.go`, `api_contribute.go`, `contribute_sse.go`, and `contribute_ws.go`
- PR-link projection:
  `contribute_prlink.go`
