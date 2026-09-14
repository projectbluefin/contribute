# Image and development guide

The repository ships two OMP-owned images:

- `ghcr.io/projectbluefin/review`, built by `image/appliance/Containerfile`,
  carries the maintainer workbench extension.
- `ghcr.io/projectbluefin/contribute`, built by
  `image/contribute/Containerfile`, carries Hive's contributor relay and OMP.

Neither image selects a provider, model, or thinking effort. OMP resolves those
inside each appliance. Local launchers prefer Podman's `krun` runtime and KVM,
then fall back explicitly to isolated Apptainer execution.

Both images pin FSDK bases by tag and digest and pin fetched runtime assets by
architecture-specific SHA-256. The contributor image installs the root
`package-lock.json` solely for Hive's pinned `ws` dependency. Hive retains
assignment, lease, prompt, credential, and completion authority.

## Development

```bash
# Maintainer appliance
just review-appliance-build

# Contributor runtime
podman build --format oci -f image/contribute/Containerfile \
  -t localhost/projectbluefin/contribute:dev .
CONTRIBUTE_IMAGE=localhost/projectbluefin/contribute:dev just contribute
```

Interactive runs use unique container names, target-specific persistent volumes,
remain foreground, and stop with `Ctrl-C`.

## Validation

```bash
pre-commit run --all-files
git diff --check
bash tests/check-commit-message.sh
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
just --list
bash tests/just-onboarding.sh
bash tests/readme-quickstart.sh
bash tests/test-registry.sh
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
bash tests/contribute-contract.sh
```

Native image builds and smoke checks run in `publish-appliance.yml` and
`publish-contribute.yml`; no third contributor image or publishing path exists.
