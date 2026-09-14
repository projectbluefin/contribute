---
name: review-dashboard
version: "4.2"
last_updated: 2026-09-14
id: review-dashboard
one_line_purpose: Maintain the single-screen OMP review workbench.
entry_point: docs/skills/review-dashboard.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [omp, extension, dashboard, review, maintainer, workflowz]
description: "Maintains the OMP review workbench in image/extension/bluefin-review/. Use when editing review UI, queue projection, workflowz dispatch, or action seams."
metadata:
  type: runbook
  context7-sources: []
---

# Review Workbench

The only maintainer UI is the OMP extension in
`image/extension/bluefin-review/`. `bin/omp-review` loads it from source;
`just review-queue` and `just review-appliance` launch the same packaged
extension from `image/appliance/Containerfile`.

The Hive contributor runtime has no maintainer UI. It attaches the terminal
directly to the OMP session Hive created.

## When to Use

Use this skill for the OMP queue, dashboard controls, workflowz dispatch,
durable slay state, or review action prompts.

## When NOT to Use

Use `launcher.md` for container launch mechanics, `review-checks.md` for review
doctrine, and `hive-runtime.md` for contributor assignment behavior.

## Core Process

1. Trace the key or flag from `dashboard.ts` through `extension.ts` to its prompt.
2. Keep review-only slay separate from write-capable fix and confirmed mutations.
3. Add a headless interaction test, then exercise the real foreground workbench.

## Authority

- GitHub owns repository state.
- Hive owns contributor selection, assignment, prompt injection, and output
  capture. The workbench may read Hive order but never claim contributor work.
- OMP owns sessions, agents, tasks, tools, workflowz workpools, and cancellation.
- The extension owns queue projection, durable user intent, mutation guards,
  and presentation.
- Humans own approval and merge decisions.

## Screen

The queue, focused item, Dagger-style execution trace, and prompt share one
screen. The top gauge reports mode, position, repository, outcomes, freshness,
Hive ordering, and actionable count. The bottom gauge reports Hive connectivity,
selection count, and the active workflowz slay.

`Tab` switches PR/issue mode and every semantic accent between the cool PR
palette and warm issue palette.

| Key | Action |
| --- | --- |
| `Tab` | Toggle pull requests and issues |
| `j` / `k` | Move through the queue |
| `Space` | Toggle the focused item |
| `A` / `x` | Select the filtered slice / clear selection |
| `Alt-B` | Select or clear the focused repository group |
| `s` | Slay selected items through mass autoreview |
| `f` | Fix selected items in isolated workspaces |
| `d` | Inspect bounded diff evidence |
| `p` | Pause or resume later wave admission |
| `r` | Refetch GitHub and Hive projections |
| `o` | Change repository or organization scope |
| `/` | Filter the queue |
| `H` / `L` | Toggle Hive-only rows / step through Hive stages |
| `t` | Focus the execution trace |
| `g` / `G` | Jump to the first / last row |
| `h` / `l` | Collapse / expand the focused trace span |
| `c` | Comment after confirmation and live revalidation |
| `Enter` | Cite the focused item in the prompt |
| `?` | Show the key guide |
| `q` / `Esc` | Close the workbench |

## Slay execution

Slay is autonomous mass review, not merge authority. Each selected item runs in
a fresh `bluefin-reviewer` workpool item; reviewers report findings but never
approve or merge. `--autoslay` starts the visible bounded slice on launch, and
`Alt-S` starts it from the active workbench.

Preserve Hive order by partitioning contiguous repository runs; an interleaved
repository returns in a later wave rather than jumping ahead. Ask workflowz to
execute every wave, including a singleton. Never implement an extension-local
worker pool, retry loop, task scheduler, or agent lifecycle. Advance on OMP's
`agent_end` only when `willContinue` is false and the wave's jobs have settled.
Pausing stops new waves; it does not pretend to suspend an agent already running.

Persist slay intent, item identity, wave position, and terminal outcomes.
Interrupted slays remain blocked after restart and require an explicit new
dispatch. Never replay a confirmed mutation.

## Mutations

Capture repository, item number, entity type, and PR head SHA before preview.
Immediately before mutation, fetch live targets again and reject missing,
changed, or type-mismatched targets. Execute `gh` with an argument array, never
a shell-composed command. The extension has no implicit merge authority.

## Policy seam

Generic queue and execution code must not know Bluefin labels or review rules.
Bluefin action vocabulary lives in `policy.ts`; review doctrine lives in the
companion agents under `image/extension/bluefin-review/agents/`.

The registered inspection tools are `hive_workbench_status`,
`hive_workbench_queue`, `hive_workbench_diff`, `hive_workbench_trace`, and
`hive_workbench_lookup`.

## Common Rationalizations

- “Batch is a neutral label.” It hides the product action; call mass autoreview
  `slay` consistently at every user-facing seam.
- “Review needs Hive admission.” Review is read-only and must still work from
  GitHub evidence when Hive is absent; write-capable fix keeps its gates.

## Red Flags

- A slay prompt uses the default task agent instead of `bluefin-reviewer`.
- `s`, `Alt-S`, and `--autoslay` enter different execution paths.
- Review-only slay can approve, merge, push, label, assign, or close.
- A repository wave advances before its OMP jobs settle.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
git diff --check
```

For a visible change, launch `bin/omp-review --no-session` in a foreground
terminal, exercise the changed key path, inspect the real screen, and stop it.
