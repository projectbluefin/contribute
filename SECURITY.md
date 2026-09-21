# Security policy

## Reporting

Report security vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/projectbluefin/contribute/security/advisories/new). Do not disclose an unpatched vulnerability in a public issue.

Include:

- vulnerability description and impact
- reproduction steps or proof of concept
- affected component (launcher, image build, publish workflow, or pin scripts)
- suggested mitigation, if available

## Response

The maintainers acknowledge reports within 48 hours and aim to assess them
within 7 days. Fix and disclosure timing depends on severity and coordination
with upstream Hive and affected consumers of the published image.

## Scope

This policy covers the `hive-contribute` launcher (`bin/hive-contribute`), the
contributor image build (`image/contribute/`), the publish and validate
workflows, the dependency pin-update scripts (`scripts/`), and the published
`ghcr.io/projectbluefin/contribute` image — in particular its credential
handling (GitHub tokens, provider API keys) and container isolation
boundaries.

Report vulnerabilities in bundled third-party components — OMP, Node.js,
`gh`, tmux, or upstream Hive's contributor runtime — to their respective
upstream projects unless the issue is introduced by this repository's
integration or pinning.

## Safe handling

Do not commit credentials, private keys, tokens, or exploit payloads. Preserve
checksum verification of downloaded artifacts, image digest pins, minimal
workflow permissions, and the non-root container user when investigating or
fixing a security issue.
