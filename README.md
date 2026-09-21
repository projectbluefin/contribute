# hive-contribute — Contributor Appliance

Upstream Hive's contributor runtime packaged as an isolated, distroless container, driven by OMP.

This appliance packages Hive's contributor runtime (`contributor-agent.sh` + `contributor-relay.js`) with OMP as the agent CLI, so a contributor needs no agent toolchain of their own. Hive owns task selection, assignment, prompts, leases, and output capture; OMP owns agent execution, model choice, thinking effort, and tool boundaries. This repository owns the isolation boundary, the credentials that cross it, and the single configuration file.

The Hive runtime inside is tracked directly from upstream's `v4` branch and is **never pinned** to a static commit in this repository. Every image build resolves the branch to a commit, stamps it into `/usr/share/hive/contribute/HIVE_COMMIT`, records it in the image labels (`io.hivecommons.contribute.hive.ref`) and SBOM, and registration clones that same branch, so setup and runtime follow one release line. They are not pinned to the same commit: `setup` reads `v4` live while the image carries the SHA resolved at its last build, so they can differ. The daily rebuild is what bounds that gap; a failed or skipped publish widens it.

## Workflow

```bash
# Run the worker in the foreground (Ctrl-C stops it)
hive-contribute

# Or through just from a checkout
just contribute
```

## Installation

Install `hive-contribute` onto your `PATH` or run directly from a checkout.

From a repository checkout:
```bash
git clone https://github.com/projectbluefin/contribute.git
cd contribute
```

The launcher executable is `bin/hive-contribute`. You can symlink or copy it to `~/.local/bin/hive-contribute` (or anywhere on your `PATH`).

## Commands

The launcher is `bin/hive-contribute`:

| Command | Description |
|---|---|
| `hive-contribute` / `hive-contribute run` | Launch the worker in the foreground (Ctrl-C stops it) |
| `hive-contribute doctor` | Read-only preflight diagnostics; starts no agent |
| `hive-contribute setup` | Register this machine with a hive through upstream's own setup |
| `hive-contribute config` | Print the resolved appliance configuration |

From a checkout, `just` provides thin wrappers: `just contribute`, `just doctor`, `just setup`, `just config`, and `just contribute-build`.

## Configuration

All site configuration lives in **one file**:
`${XDG_CONFIG_HOME:-~/.config}/hive-contribute.yml`

The launcher creates it on first run, seeding `hub` from an existing `~/.config/hive/contributor.env` if present. You can point `HIVE_CONTRIBUTE_CONFIG` at another path to run a second configuration.

The configuration has nine flat keys:

```yaml
# hive-contribute — the whole appliance configuration.
#
# hub          the hive this machine contributes to (wss://<host>/contribute)
# registration Hive's own credential file, written by its contribute-setup
# image        contributor runtime image to run
# backend      agent CLI Hive drives inside the container
# memory       RAM ceiling for the worker (also the microVM's size); none = no limit
# cpus         CPU ceiling for the worker (also the microVM's vCPUs); none = no limit
# llmman       OpenAI-compatible base URL of YOUR llmman daemon; empty = cloud only
# llmman_token file holding that daemon's API key (0600); empty = unauthenticated
# llmman_model model the daemon must serve; 'doctor' checks it is loaded there
hub: wss://hive.example.org/contribute
registration: ~/.config/hive/contributor.env
image: ghcr.io/projectbluefin/contribute:stable
backend: omp
memory: 4g
cpus: 2
llmman:
llmman_token:
llmman_model:
```

| Key | Meaning | Default |
|---|---|---|
| `hub` | The hive WebSocket endpoint to join (`wss://<host>/contribute`) | Seeded from registration or set via `setup` |
| `registration` | Path to Hive's credential file | `~/.config/hive/contributor.env` |
| `image` | Contributor runtime image reference (registry location) | `ghcr.io/projectbluefin/contribute:stable` |
| `backend` | Agent CLI Hive drives inside the container | `omp` |
| `memory` | RAM ceiling, swap pinned to it; `none` removes it | `4g` (upstream's contributor envelope) |
| `cpus` | CPU ceiling; `none` removes it | `2` (upstream's contributor envelope) |
| `llmman` | OpenAI-compatible base URL of your own llmman daemon | empty — the worker uses cloud providers only |
| `llmman_token` | File holding that daemon's API key | empty — the endpoint is contacted unauthenticated |
| `llmman_model` | Model the daemon must serve, verified by `doctor` | empty — `doctor` lists what is served instead |

`memory` and `cpus` are enforced on Podman runs, where they size the microVM.
## Isolation Model

Every worker invocation runs inside an isolated container:

- **libkrun microVM preferred**: When Podman, `krun`, and `/dev/kvm` are available, the launcher starts a hardware-isolated KVM microVM (`podman run --runtime=krun`). When KVM is unavailable, it runs standard Podman containers.
- **Read-only credential mount**: Hive's `0600` registration file is mounted read-only at `/home/hive/.config/hive/contributor.env:ro`.
- **No host home mount**: The user's host `$HOME` is never mounted. The container runs as unprivileged user `hive` (uid/gid 65532) with its own isolated home volume.
- **Foreground attach**: The container remains attached to the terminal in the foreground. Detached runs are unsupported; Ctrl-C stops the invocation cleanly.

## Credential Model

- **GitHub identity**: Passed by environment as `GH_TOKEN` (resolved from `$GH_TOKEN`, `$GITHUB_TOKEN`, or `gh auth token`). Host `~/.config/gh` is never mounted into the container.
- **`gh` is Hive's, not raw**: Inside the container, `gh` is upstream's `gh-wrapper.sh` with the real binary at `/opt/hive/bin/gh-real`, and contributor mode is a root-owned marker file the agent cannot forge. An assigned task cannot run `gh auth`, cannot issue a mutating `gh api`, and cannot reach any subcommand outside Hive's allowlist; read-only lookups stay available, and created issues and PRs are labelled `contributor/<login>` and `cli/omp`.
- **Provider keys**: Only allowlisted provider environment variables (`COPILOT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.) are forwarded.
- **Credential validity is Hive's**: The hub issues and rotates registration tokens, and its relay is what authenticates one. This launcher mounts the credential and nothing more — it does not validate, reissue, or relaunch on a rejected token. Repair a rejected registration with upstream's `contribute-move`.

## Local Inference (Bluefin Agent Mode / llmman)

Bluefin's Agent Mode runs [`llmman`](https://github.com/llmmanorg/llmman) as a rootless user service bound to the host's loopback address, which an isolated container cannot reach. The appliance can run its assigned work against that daemon — but only when you say so.

**Local inference is off until you select it.** With `llmman` empty, the launch is byte-for-byte what it was: whatever cloud provider keys you have configured, and nothing else. Writing an endpoint into the config file is the selection:

```yaml
llmman: http://127.0.0.1:17434/v1
llmman_token: ~/.config/llmman/api.key   # optional; 0600
llmman_model: qwen3-coder-30b            # optional; doctor verifies it
```

Then check it before you run a worker:

```bash
hive-contribute doctor
```

`doctor` reports the endpoint and the transport, reads the key, and makes one read-only `GET` of the OpenAI-compatible model list — so reachability, authentication, and whether `llmman_model` is actually loaded are all answered before an assignment arrives, not after one fails.

What crosses the isolation boundary when it is selected:

- **The transport**: for a loopback endpoint the run adds `--network slirp4netns:allow_host_loopback=true`, which is Podman's documented route from a container to a service on the host's `127.0.0.1`, and the container reaches it at `10.0.2.2`. An endpoint you already reach over the network is passed through unchanged and gets no special network mode. Either way the appliance publishes no port, shares no host network namespace, and starts no listener.
- **`OPENAI_BASE_URL`**, by value — it is an address, not a secret, and a recorded one is how you prove afterwards which endpoint the worker used.
- **`OPENAI_API_KEY`**, by name, holding the contents of `llmman_token`. It is never written into the image, never placed on a command line, and never read from a mounted host home. With no `llmman_token`, the appliance sends its own placeholder rather than your cloud OpenAI key — an endpoint of your own does not get a credential for someone else's.

Nothing else changes: the same read-only registration mount, the same `keep-id` user namespace, the same isolated home volume, the same credential allowlist. Your cloud providers stay available inside OMP, and **OMP still owns model choice** — `llmman_model` is what `doctor` verifies and what the launch banner names, not a model imposed on the agent.

### Donating worker capacity is not llmman peer aggregation

Two different things share the word "local", and this appliance does exactly one of them:

- **Donating worker capacity** (this repository): you run the contributor appliance, Hive assigns it work, and with `llmman` set that work is inferred on your own machine instead of a cloud provider. The appliance is a **client** of one endpoint you named.
- **llmman peer aggregation** (llmman's own feature): one machine consumes another machine's llmman daemon over the network. That is configured in llmman with `llmman config set`, it is not something this launcher does, and nothing here advertises your daemon as a peer or opens it to the LAN.

If you want your workstation's GPU to serve your laptop, that is llmman's aggregation, configured in llmman. If you want Hive's assigned work to run on hardware you own, that is the `llmman` key above.

## Upstream Tracking (Never Pinned)

The Hive contributor runtime inside the image is **never pinned** to a static commit. The build resolves the upstream `v4` tracking branch, packages the resolved runtime assets, and stamps the commit into:
1. `/usr/share/hive/contribute/HIVE_COMMIT` inside the image
2. The OCI image label `io.hivecommons.contribute.hive.ref`
3. The image SBOM at `/usr/share/hive/contribute/sbom.spdx.json`

`hive-contribute setup` clones that same upstream tracking branch during registration, ensuring registration protocol and container runtime stay synchronized.

Third-party release binaries (OMP, Node.js, GitHub CLI, tmux) remain digest-pinned and tracked via Renovate.

## Quick Start

```bash
hive-contribute
```

That is the whole flow. On a machine with nothing configured it writes its
config, hands off to upstream Hive's `contribute-setup` to pick a hive and
register, records the hub it registered against, and starts the worker. Choose
provider, model, and reasoning effort inside OMP.

**First run needs a host toolchain**, because registration is upstream's and
runs on the host: `just`, `gh`, `git`, `curl`, `jq`, and `node`. The launcher
names any that are missing before it touches the network or a credential. Log
in to GitHub first, since upstream's setup reads that identity:

```bash
gh auth login --web --hostname github.com --scopes repo,read:org
```

Once a registration exists, the setup-only tools (`just`, `git`, `curl`, `jq`,
`node`) are no longer needed. Every run still needs a container runtime —
Podman with `krun` — and a GitHub token, either from `gh` or exported as `GH_TOKEN`.

### If something is wrong

```bash
hive-contribute doctor     # read-only preflight; starts no agent
hive-contribute setup      # re-run registration through upstream on its own
hive-contribute config     # print the resolved configuration
```


## Image Reference

The default contributor runtime image is published to GitHub Container Registry at `ghcr.io/projectbluefin/contribute:stable` (used here as a container registry location). Build locally with:
```bash
just contribute-build
```

### Running directly with Podman

To run the container directly with `podman` (preserving host access to the `0600` registration file):

```bash
podman run --rm -it \
  --userns keep-id:uid=65532,gid=65532 \
  -v ~/.config/hive/contributor.env:/home/hive/.config/hive/contributor.env:ro,z \
  -v hive-home:/home/hive:rw \
  -e GH_TOKEN \
  ghcr.io/projectbluefin/contribute:stable
```

### Running with Docker

For environments using Docker, map your host user ID and bind-mount a dedicated host-owned directory for `/home/hive` so the container process can read the `0600` registration file and write to its home and workspace:

```bash
mkdir -p ~/.local/state/hive-contribute/home/{.config/hive,workspace}

docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "${HOME}/.local/state/hive-contribute/home:/home/hive" \
  -v "${HOME}/.config/hive/contributor.env:/home/hive/.config/hive/contributor.env:ro" \
  -w /home/hive/workspace \
  -e GH_TOKEN \
  ghcr.io/projectbluefin/contribute:stable
```
## Guides

- **Launcher:** [`docs/skills/launcher.md`](docs/skills/launcher.md)
- **Runtime contract:** [`docs/skills/hive-runtime.md`](docs/skills/hive-runtime.md)
- **Triage & troubleshooting:** [`docs/skills/hive-triage.md`](docs/skills/hive-triage.md)
- **Image build & development:** [`docs/image-and-development.md`](docs/image-and-development.md)
- **Agent contract:** [`AGENTS.md`](AGENTS.md)
- **All documentation:** [`docs/SKILL.md`](docs/SKILL.md)

Licensed under [Apache 2.0](LICENSE).
