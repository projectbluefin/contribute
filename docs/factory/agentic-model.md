# Bluefin Agentic Factory Feedback Loop

This document is the canonical local model for `review`. It adapts
[`projectbluefin/common`'s Agentic Operating Model][common-model] to this
repository's OMP workbench and Hive contributor runtimes. Read it after
`AGENTS.md` and before task-specific skills.

The repository ships two purpose-specific runtimes:
1. The distroless review appliance (`image/appliance/Containerfile` ->
   `ghcr.io/projectbluefin/review`) packages the only maintainer UI: the OMP
   extension in `image/extension/bluefin-review/`. Both `just review-queue` and
   `just review-appliance` launch it. OMP owns agent execution, sessions, tasks,
   workflowz, and tool boundaries.
2. The contributor runtime (`image/contribute/Containerfile` ->
   `ghcr.io/projectbluefin/contribute`) packages Hive's worker and OMP. Both
   contributor convenience commands launch it; OMP owns model and effort.

Local launchers run either OCI image through Podman's `krun` runtime. Each
invocation is a separate foreground KVM microVM with a unique container name;
repository or explicit instance identity selects separate persistent OMP state.

Hive assignment authority remains separate from the human review surface:
Hive assigns contributor tasks, while maintainer review sessions consume Hive
reads as optional, non-mutating context and ordering.
The model is documentation: the launcher, image, tests, skills, and
user-facing instructions must describe the same roles and authority
boundaries. When source evidence changes the model, update this document and
the affected local contract together. Do not preserve superseded plans,
session logs, or design scratchpads as competing explanations.

## Roles and authority

| Term | Meaning | Authority |
|---|---|---|
| **Bluefin Agentic Factory Feedback Loop** | The lifecycle that turns agent work and test feedback into reviewed Bluefin changes. | The model for this repository. |
| **Toil** | Repetitive, low-novelty maintenance work an under-maintained project needs: broken CI, stale pins, drifted documentation, unreproduced reports, untriaged issues, stalled branches. | Toil is the work this factory exists to absorb. |
| **Contributor** | A contributor using the worker configuration to receive and complete Hive-assigned work. They are treated as a contributor, they just happen to specialize in the `clanker-queue`. It's a "subclass" of contributor like a video game RPG character. Same team, different specialization. | Hive assigns work; the worker implements only its assigned scope. |
| **Maintainer/Reviewer** | A maintainer assessing an incoming pull request or issue. Active review process requiring human judgement and decision. | The human decides review, approval, and merge. |
| **Review Evidence** | Read-only pull-request, issue, verification, trace, and merge-state context shown before a review. | Evidence informs a human; it never makes a decision. |
| **Review Mode / Extension** | The sole maintainer workbench in `image/extension/bluefin-review/`. It provides the live queue, pipeline trace, companion agents, and inspection tools. | OMP owns execution, session, workflowz, and tool boundaries. |
| **Managed Reviewer Client** | A foreground OMP workbench a maintainer uses to examine evidence and prepare actions. | It executes only typed, human-confirmed decisions and decides nothing itself. |
| **Portable Reviewer Prompt** | Markdown Review Evidence and queue instructions for a maintainer's own client. | It is context, not an assignment. |
| **Bluefin PR Queue** | A live GitHub view of open pull requests and issues, optionally ordered by Hive positions. | GitHub is authoritative for repository state; Hive orders when configured; the queue neither assigns work nor merges. |
| **Workbench Activity** | The bounded projection of active workflowz tasks, outcomes, queue state, and freshness. | It reports observed state and never assigns Hive work. |
| **Review Draft** | Analysis, review text, or commands prepared for a Maintainer Reviewer. | A human explicitly considers and submits it. |

Avoid classifying contributors by role; this isn't a class system it's the loadout a contributor chooses to use that day.

## Two layers

The factory has a human layer and an agent layer, governed by different rules.
Conflating them is the most likely misreading of this model.

The **agent** does the unglamorous work: the toil defined above, in small,
evidenced, reviewable changes. They are humorously referred to as clankers as a joke on the absurdity of the world we live in.

The **human** does the "unglamorous work" of directing agents — scoping a task,
judging the output, and carrying the result to a maintainer. Their standing is
earned under ordinary open-source contribution culture, which AI did not
change; projects determine it, and Hive may use it when distributing work.
Nothing in this repository sets, scores, or automates it, and the
`human-queue` is out of scope here.

The IMPORTANT DISTINCTION in the culture is that the humans take pride in maintaining systems at the highest levels. If they are doing their jobs, they are invisible. We are designing this tool because the mental toll of that maintenance is hurting people. Amongst their peers there is a culture of respect and craftmanship. The leaderboards/contribution graphs are supposed to be a friendly way to remind maintainers that their work is recognized by their peers. This is one of the highest honors a maintainer can receive. Silent professionals.

Do not reconcile the two layers by applying agent scope rules to the human, or
by reading the human ladder as a statement about agent output.

## Scope of work

This is a toil-reduction factory for under-maintained open-source projects,
not a feature factory. Factory Workers repair what is already broken and
finish what a project already decided to do; they do not add features,
dependencies, configuration surfaces, or architecture.

Well-staffed projects restrict large agent-authored pull requests because
those consume more maintainer attention than they return. That reasoning is
the model here too: the reviewer's attention is the scarce resource, so a
change is sized to be reviewable rather than to be complete in one pass. When
an assigned task can only be finished by out-of-scope work, the deliverable is
an evidenced written finding. That is completed work, not a declined
assignment; Hive's authority over what gets worked on is unchanged.

[`docs/skills/contribution-culture.md`](../skills/contribution-culture.md)
carries the operational form of this section.

## Repository boundary

`review` ships the review appliance image, the OMP extension, the contributor
image, credential handoff, and review context.

OMP owns agent execution, sessions, tasks, and companion review tool boundaries
in the primary maintainer product. Hive reads remain optional, read-only
context and queue ordering for maintainers.

Hive owns the contributor WebSocket protocol, task selection, assignment prompt
injection, the `contributor` tmux session, and output capture. The launcher
must not decline, retry, or otherwise manage assignments mid-protocol; the
one permitted filter is own-work exclusion on the maintainer-facing queue
view, so a reviewer never receives their own authored pull requests.
Hive also owns contributor completion. Review may display a read-only Hive
projection, but it never completes an assignment.

The `contribute` image defines one narrow contributor experience: it always
launches OMP and rejects every other `AGENT_BACKEND` value before Hive starts.
Its FSDK closure contains only the tools required by OMP and Hive's interactive
relay. The generic upstream helper files needed by that relay are implementation
dependencies, not alternate agent surfaces. No dashboard, review extension,
scheduler, Codex, Pi, or provider state belongs in the image.
The human Maintainer Reviewer owns approval, queueing, and merge decisions.
The workbench previews and confirms comments against a freshly revalidated
target, and dispatches reviews or fixes through OMP. It has no approval,
`lgtm` queueing, or merge control; dispatched agents must not approve or merge.
A clean review is evidence for the maintainer, never permission to land.

The pinned FSDK base owns the contributor toolchain. `review` consumes the
tools the image ships and does not reimplement them: a missing utility is
fixed at the FSDK seam, and a shim is removed the moment that fix lands. A
local reimplementation is not a neutral stopgap — it shadows the real tool on
`PATH` and silently substitutes its own semantics for the ones every caller
assumes.



## Documentation discipline

Keep the model executable and compact:

1. Treat local code and tests as evidence for implementation behavior.
2. Treat `AGENTS.md`, this document, and the matching skill as the
   agent-facing contract.
3. Record durable operational knowledge in `docs/skills/` and generate
   `docs/skills/index.json` from skill frontmatter.
4. Delete stale changelogs, session notes, plans, design scratchpads, and
   append-only status documents. They are historical noise, not the model.
5. Use the pinned `projectbluefin/common` catalog as a shared sidecar after
   local documentation; it complements but does not override local authority.
   Its [factory onboarding sequence][common-onboarding] is the shared entry
   procedure and self-repair loop; follow it there rather than restating it
   here.

## Verification

CI enforces the complete verification suite in `.github/workflows/validate.yml` (see [`docs/image-and-development.md`](../image-and-development.md#validation) for the full local command list).

For factory model, skills, and image contract changes, run the core contract checks:

```bash
pre-commit run --all-files
git diff --check
just --list
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
bash tests/contribute-contract.sh
bash tests/just-onboarding.sh
```
[common-model]: https://github.com/projectbluefin/common/blob/main/docs/factory/agentic-model.md
[common-onboarding]: https://github.com/projectbluefin/common/blob/main/docs/skills/factory-onboarding.md
