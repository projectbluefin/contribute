# review PR

## What does this change?

<!-- Required: one sentence -->

## Why?

<!-- Link the issue this closes: "Closes #NNN" -->
Closes #

## Checklist

- [ ] PR title follows Conventional Commits (`fix:`, `feat:`, `docs:`, `ci:`, `refactor:`, etc.)
- [ ] `bash scripts/check-skill-frontmatter.sh` passes
- [ ] `bash tests/generate-skills.sh` passes
- [ ] `bash tests/appliance-contract.sh` and `bash tests/contribute-contract.sh` pass
- [ ] `bash tests/just-onboarding.sh` passes
- [ ] `git diff --check` is clean
- [ ] `just --list` parses
- [ ] `pre-commit run --all-files` passes
- [ ] Durable, source-backed learning is captured in the matching skill when this change reveals one (see [`docs/skills/skill-improvement.md`](../docs/skills/skill-improvement.md))
- [ ] `AGENTS.md` / `docs/SKILL.md` / `docs/skills/` links remain valid
- [ ] CI is green after push: `gh run list --repo projectbluefin/review --limit 5`

## AI attribution

If this PR includes AI-authored commits, include both trailers:
```
Assisted-by: <Model> via GitHub Copilot
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
