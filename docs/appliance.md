# The review appliance

`ghcr.io/projectbluefin/review` is one OCI image that reviews Project Bluefin
pull requests. The `bluefin` launcher prefers a dedicated libkrun microVM and
falls back cleanly to an isolated Apptainer container when KVM is unavailable.

```bash
podman run --runtime=krun --rm -it \
  --name "bluefin-review-example-$(date +%s)-$$" \
  --userns keep-id:uid=65532,gid=65532 \
  --volume bluefin-review-example-home:/home/bluefin \
  --volume bluefin-review-example-workspace:/workspace \
  --env GH_TOKEN \
  ghcr.io/projectbluefin/review:stable
```

or, from a checkout, `just review-appliance`.

## What is inside, and why

The base is `ghcr.io/projectbluefin/base` — Project Bluefin's distroless FSDK
image: glibc, CA certificates, tzdata, and the full terminfo database including
`xterm-ghostty`. No shell, no package manager, no distro userland.

On top of it sit exactly two fetched artifacts and one staged closure:

| Component | Why it is here |
| --- | --- |
| `omp` | The agent. A single Bun executable with its own embedded runtime; the image's entrypoint. |
| `gh` | The appliance reviews, approves and merges through it. |
| `bash`, `git`, `python3`, and eleven utilities | The shell `omp`'s `bash` tool spawns, Python runtime, and what a shell one-liner assumes exists. |

Every fetched artifact is verified against a SHA-256 recorded in the
Containerfile before it is allowed to become executable, and the two FSDK images
are pinned as tag *and* digest — the digest is what builds, the tag is what
Renovate can compare against.

### The one deviation from distroless

A shell is present, deliberately. `omp`'s `bash` tool spawns one, and an agent
that cannot run `gh pr checks` is not a review appliance. FSDK's own container
standard treats a shell as the named exception rather than a contradiction; this
image keeps that exception down to one binary and a dozen small utilities
(`grep`, `sed`, `gawk`, `find`, `xargs`, `tar`, `gzip`, `diff`, `less`, `curl`, `python3`)
instead of a userland. Nothing inside can install anything: there is no `dnf`,
`apt`, `apk`, `pip`, or `npm`, and `tests/appliance-contract.sh` fails the build
if one appears.

### What is deliberately absent

`pi` and `node` — OMP is the sole agent runtime and embeds Bun. `ssh` — the
appliance talks to GitHub over HTTPS with a token. `strip` — stripping `omp`
produces a binary that still runs and silently reports Bun's version instead of
its own, which is worse than the 8 MiB it saves.

## Versioning

FSDK's scheme with one component added: `<fsdk-series>.<tool-revision>`.

```
ghcr.io/projectbluefin/base:26.08.0   +   image/appliance/REVISION = 6   ->   26.08.06
```

The series is never written down twice. `scripts/review-appliance-version.sh`
reads it from the pinned base in `image/appliance/Containerfile`, so rebasing
onto a new freedesktop-sdk release moves the appliance version with it and cannot
drift from what actually shipped. The only hand-maintained number is the
revision, bumped when the appliance changes on an unchanged base.

Published tags:

| Tag | Meaning |
| --- | --- |
| `26.08.06` | Immutable. The publish workflow refuses to overwrite an existing one. |
| `stable` | Moving alias for the newest published build. |
| `sha-<commit>` | Immutable, published for every build including branches. |

OCI tags are replaced, never updated in place. The appliance disables omp's
startup update check, and `omp update` exits with instructions to pull a newer
image. This keeps the running artifact identical to what was verified and
published.

## Running it

State lives under `/home/bluefin`: OMP sessions, logs, caches, provider
credentials, and workbench slay intent. The launcher derives a persistent
volume from the selected repository and a unique container name per invocation,
so `bluefin review org/repo` and `bluefin review org/repo2` can run concurrently
without sharing session or workspace state. Set `BLUEFIN_INSTANCE` to split the
same target.

### First run signs in

A fresh container has no model credential, so the first launch opens omp's own
five-step setup and asks which provider to sign in with. That is one time per
volume, not per run: the credential is written under `/home/bluefin` and the next
launch goes straight to the queue. Skip the wizard entirely by passing a key the
provider accepts from the environment:

```bash
podman run --runtime=krun --rm -it \
  --name bluefin-review-example \
  --userns keep-id:uid=65532,gid=65532 \
  --volume bluefin-review-example-home:/home/bluefin \
  --volume bluefin-review-example-workspace:/workspace \
  --env GH_TOKEN --env ANTHROPIC_API_KEY \
  ghcr.io/projectbluefin/review:stable
```

`just review-appliance` passes `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`,
`GITHUB_COPILOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `HIVE_HUB`
through by name, and resolves `GH_TOKEN` from `gh auth token` when it is unset.

The appliance uses its own `bluefin-review-appliance` OMP profile. Host OMP
configuration is not mounted by default, so host MCP entries cannot make the
appliance noisy or unusable. To deliberately provide host configuration, mount
it into the target-specific home and set `BLUEFIN_REVIEW_INHERIT_OMP_CONFIG=1`.
The appliance never edits host configuration directly.
The immutable invocation overlay enables fresh workflowz agents, caps task
concurrency at four and recursion at one, isolates task worktrees without
auto-applying them, uses a one-hour task deadline and a bounded request budget,
keeps tool intent traces out of model context, and selects low text verbosity.
OMP resolves every model and effort choice from the user's active configuration;
the appliance and its agents impose no model mapping or filtering.

### The agents it carries

The agent definitions under `/usr/share/bluefin/review/extension/agents` ship
with the image and are discovered by OMP directly. They cover doctrine,
correctness, security, test coverage, simplicity, CI triage, queue triage, and
coordinated review. They deliberately omit model and effort fields, leaving both
choices to the user's active OMP configuration.

### Hive decides the order

With `HIVE_HUB` set — or a registration mounted at
`$HOME/.config/hive/contributor.env` — the queue is ordered by Hive's own work
queue and triage view, in Hive's positions. The appliance only reads: it never
assigns, completes, or reprioritizes anything, because that is Hive's job and
the maintainer's. Without a hub the queue is classified from live GitHub
evidence using the policy layer's action vocabulary. The header always names
which authority ordered the queue.

Hive's queued work is in the queue whether or not a GitHub search would have
found it. The search covers what is recent; anything Hive ranked is then
fetched by name and added, because a backlog is rarely the most recently
updated thing in an organization. The header counts it as `N/M queued`, so a
queue that is short because Hive's work could not be resolved on GitHub — a
closed item, a repository the token cannot read — is visibly different from a
queue that is short because Hive has little to do.

### Working the backlog down

The loop is select, group, and dispatch:

1. `Tab` switches pull-request and issue mode. `L` steps through Hive's own
   stages; `/` filters by title, repository, author, label, or number.
2. `Space` toggles one item, `Alt-B` selects the focused repository group, and
   `A` selects the filtered slice up to the bounded slay limit.
3. `s` slays the selection through mass autoreview. The extension preserves Hive
   order, partitions by repository, and asks workflowz to run one bounded
   `bluefin-reviewer` workpool per repository. `--autoslay` starts that flow on
   launch.
4. `p` pauses admission of later repository waves without pretending to suspend
   agents already running.

Issue implementation in managed repositories is gated on a fresh GitHub read
of the policy layer's admission and denial labels. Any closed, unadmitted,
held, blocked, unreadable, or incompletely read issue rejects the whole
selection. The dispatched agents may prepare changes and pull requests, but they
never approve or merge.

Credentials are inherited by name (`--env GH_TOKEN`), never passed as arguments
and never baked into a layer. The mode resolves a token from `GH_TOKEN`,
`GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, or `gh auth token` in that order.

Arguments reach `omp` directly, so the mode's flags work as documented:

```bash
podman run --runtime=krun --rm -it … ghcr.io/projectbluefin/review:stable --pr 1284
podman run --runtime=krun --rm -it … ghcr.io/projectbluefin/review:stable --issues
```

The image runs as uid `65532` with a matching `/etc/passwd` entry, because a
numeric-only user with no passwd record breaks `getpwuid()` — which is exactly
what a rootless runtime calls. Under Kubernetes it satisfies `runAsNonRoot` with
`runAsUser: 65532`.

## Building and verifying it

```bash
just review-appliance-build                 # build, then hold it to its contract
bash tests/appliance-contract.sh            # static half only, no engine needed
```

The contract test is in two halves. The static half reads the Containerfile and
the version machinery. The runtime half runs the image: it executes every
bundled binary, makes `git` create a real commit, checks that the HTTPS remote
helper resolved its TLS closure, proves no package manager is reachable, reads
the in-image SBOM, and holds the image under a size ceiling. That ceiling is not
decoration — the first draft of this image shipped 284 MiB of esbuild binaries
for platforms it cannot execute.

The image carries its own SPDX document at
`/usr/share/bluefin/review/sbom.spdx.json`. syft only sees package-manager
metadata, and every component here arrived as a release archive, so without it
the attested SBOM would describe an image whose load-bearing parts are invisible.
The publish workflow ingests it through syft's `sbom-cataloger` and attaches the
result as an attestation.

The packaged launcher prefers rootless Podman's `krun` OCI runtime and
read/write access to `/dev/kvm`. If any KVM prerequisite is unavailable, it
reports the reason and uses the installed Apptainer fallback.
