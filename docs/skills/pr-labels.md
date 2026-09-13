---
name: pr-labels
version: "1.1"
last_updated: 2026-09-13
id: pr-labels
one_line_purpose: Enforce projectbluefin's lifecycle, queue, and automation label taxonomy.
entry_point: docs/skills/pr-labels.md
category: meta
status: active
tags: [labels, factory, triage, automation, workflow]
description: "Defines projectbluefin's lifecycle label taxonomy, queue structure (3-clanker-queue, 3-human-queue), and automation labels (lgtm, automerge). Use when managing labels or triage."
metadata:
  type: policy
  context7-sources: [/pre-commit/pre-commit]
---

# Pull Request Labels

> Workflows own state; humans provide intent. Project Bluefin standardizes
> lifecycle labels, admission queues, and repository automation labels.

## When to Use

Load this when triaging issues/PRs, assigning factory workflow labels, or
inspecting queue admissions.

## When Not to Use

Do not load this for git commit conventions or branch preparation (`pr-workflow.md`).

## Lifecycle and Queue Labels

The repository defines seven core lifecycle and queue labels:

| Label | Meaning |
|---|---|
| `1-triage` | New work awaiting human triage. |
| `2-discussing` | Work requiring discussion or a clarified design. |
| `3-clanker-queue` | Explicit agent admission: reconciled OMP slice, clear dependencies and writer; enforcement per #169. |
| `3-human-queue` | Work admitted to the human-maintained queue. |
| `4-review` | A pull request is awaiting review. |
| `blocked` | Work is blocked on human input or an external dependency. |
| `hold` | Work is intentionally paused. |

### Queue Admission (Stage 3)

Stage 3 branches work into two separate queues depending on execution authority:
- `3-clanker-queue`: Autonomous agent queue. Scoped for unattended or agent-assisted execution with clear boundaries and a reconciled slice.
- `3-human-queue`: Human maintainer queue. Complex, design-heavy, or non-automatable work reserved for human contributors.

Never use obsolete stage-3 or stage-4 labels like `3-ready` or `4-working`.

### Review and Blocked States

- `4-review`: Code changes are complete and awaiting maintainer or automated review (replaces the obsolete `5-review`).
- `blocked`: Progress is halted by an external blocker or missing prerequisite.
- `hold`: Work is intentionally paused by a maintainer. Agents must never remove a hold.
- Terminal resolution (done) is tracked directly through issue/PR closure or merge, not a `6-done` label.

## Automation and Merge Labels

This repository carries two automation labels:

| Label | Meaning |
|---|---|
| `lgtm` | Human approval flag permitting automated merge when CI passes. |
| `automerge` | Signals eligibility for automated merge on green CI when authorized. |

The obsolete `override` and `security-advisory` labels do not exist in this repository.

## Agent and Domain Labels

The repository also maintains domain qualification and agent assignment labels:
- **Agent labels** (`agent/*`): `agent/ci-maintainer`, `agent/quality`, `agent/architect`, `agent/security`, `agent/scanner`.
- **Domain & subsystem labels**: `ci`, `quality`, `testing`, `architecture`, `tech-debt`, `security`, `bug`, `dependencies`, `chore/deps`, `hive-protocol-change`, `needs-human`, and hosted Hive identifiers.

## Core Process

1. Agents never self-assign `3-clanker-queue` or `3-human-queue`, or manipulate
   labels to cherry-pick tasks. Hive and human maintainers are the sole
   admission authorities.
2. Label changes reflect verified state transitions, not speculative intentions.
3. Apply `lgtm` only when human review criteria are satisfied. Maintainers,
   not agents, own `lgtm`.
4. Agents never remove `hold` or `blocked` before the blocking condition is
   genuinely resolved.

## Red Flags

- Inventing repository-local label variants or using obsolete labels (`3-ready`,
  `4-working`, `5-review`, `6-done`, `override`, `security-advisory`).
- Relabelling issues to attract or shed Hive assignments.
- Removing `blocked` or `hold` before the blocking or pause condition is resolved.
- Agents self-admitting work to `3-clanker-queue` or modifying queue labels.

## Verification

```bash
gh label list --repo projectbluefin/review
```
