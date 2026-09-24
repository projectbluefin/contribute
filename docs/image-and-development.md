# Image and development guide

The repository ships one OMP-owned image:

- `ghcr.io/projectbluefin/contribute` (used as a container registry location), built by
  `image/contribute/Containerfile`, carries Hive's contributor runtime and OMP.

The image does not select a provider, model, or thinking effort. OMP resolves those
inside the appliance. Local launchers prefer Podman's `krun` runtime and KVM,
and run standard Podman containers when KVM is unavailable. The appliance requires
a Linux host environment (or a Linux VM on macOS via Lima or Windows via WSL2).
The image uses FSDK base images (`ghcr.io/projectbluefin/base:26.08`, used as a build input location)
pinned by tag and digest, and pins fetched binary release assets by
architecture-specific SHA-256. The contributor image installs the root
`package-lock.json` solely for Hive's `ws` dependency. Hive retains
assignment, lease, prompt, credential, and completion authority.

Hive's contributor runtime components (`contributor-agent.sh`, `contributor-relay.js`,
`pi-backend.js`, `lib/pane-classifier.js`, `backends.conf`, `gh-wrapper.sh`, and
`restrictions/contributor-default.json`)
are fetched from upstream Hive's `v4` tracking branch and resolved to a commit SHA
at build time. The resolved SHA is stamped into `/usr/share/hive/contribute/HIVE_COMMIT`,
labeled on the image (`io.hivecommons.contribute.hive.ref`), and recorded in the SBOM.
Hive runtime code is never pinned to a static commit.

The daily Renovate workflow follows stable `can1357/oh-my-pi` GitHub releases.
Its allowlisted post-upgrade task runs `node scripts/update-omp-pins.mjs`, which
updates the OMP version and per-architecture digests in `image/contribute/Containerfile`.
After checks pass, the OMP-only Renovate PR automerges; that `main` push publishes
the native multi-architecture image.

## Development

```bash
# Contributor runtime
just contribute-build
```

To run that build instead of the published image, set
`image: localhost/hive/contribute:dev` in the configuration file — or in a copy
of it selected with `HIVE_CONTRIBUTE_CONFIG` — and run `just contribute`.
Interactive runs use unique container names, target-specific persistent volumes,
remain foreground, and stop with `Ctrl-C`.

## Validation

```bash
pre-commit run --all-files
git diff --check
bash scripts/check-skill-frontmatter.sh
bash tests/launcher-contract.sh
just --list
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
bash tests/contribute-contract.sh
```

Native image builds and smoke checks run in `publish-contribute.yml`.
