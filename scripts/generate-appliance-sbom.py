#!/usr/bin/env python3
"""Write the SPDX manifest for the review appliance's fetched components.

The appliance fetches the omp binary and GitHub CLI directly. syft only
inventories package-manager metadata, so without this document those two
load-bearing components would be invisible.

This runs inside the build, where every pin is a resolved build argument, and
writes SPDX 2.3 JSON to ``/usr/share/bluefin/review/sbom.spdx.json``. The publish
workflow's syft run ingests it through the sbom-cataloger, so each component
reaches the attestation with its pinned version, its versioned download URL, and
the SHA-256 the build actually verified before executing it.

This generator is intentionally self-contained because it is copied alone into
the image build stage.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone
import re

SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")

# Each publisher names architectures differently in its release assets.
OMP_ARCH = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}
GH_ARCH = {"x86_64": "amd64", "aarch64": "arm64"}


def require_sha256(value: str, label: str) -> str:
    if not SHA256_PATTERN.fullmatch(value):
        raise SystemExit(f"{label} must be a lowercase SHA-256 hex digest, got: {value!r}")
    return value


def require_non_empty(value: str, label: str) -> str:
    if not value:
        raise SystemExit(f"{label} must not be empty")
    return value


def with_checksum_qualifier(purl: str, sha256: str) -> str:
    # syft's sbom-cataloger keeps name, version and externalRefs when merging an
    # embedded document, so the verified digest rides through as the purl spec's
    # standard checksum qualifier.
    return f"{purl}?checksum=sha256:{sha256}" if sha256 else purl


def package(
    name: str,
    version: str,
    download_url: str,
    purl: str,
    comment: str,
    sha256: str = "",
) -> dict:
    entry = {
        "name": name,
        "SPDXID": f"SPDXRef-Package-{name.replace('/', '-').replace('@', '')}",
        "versionInfo": version,
        "downloadLocation": download_url,
        "filesAnalyzed": False,
        "externalRefs": [
            {
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": with_checksum_qualifier(purl, sha256),
            }
        ],
        "comment": comment,
    }
    if sha256:
        entry["checksums"] = [{"algorithm": "SHA256", "checksumValue": sha256}]
    return entry


def per_arch(args: argparse.Namespace, prefix: str, arch: str) -> str:
    return require_sha256(vars(args)[f"{prefix}_{arch}"], f"{prefix} for {arch}")


def build_packages(args: argparse.Namespace, arch: str) -> list[dict]:
    omp_version = require_non_empty(args.omp_version, "omp version")
    gh_version = require_non_empty(args.gh_version, "gh version")

    omp_sha = per_arch(args, "omp_sha256", arch)
    gh_sha = per_arch(args, "gh_sha256", arch)

    return [
        package(
            "omp",
            omp_version,
            "https://github.com/can1357/oh-my-pi/releases/download/"
            f"v{omp_version}/omp-{OMP_ARCH[arch]}",
            f"pkg:github/can1357/oh-my-pi@v{omp_version}",
            "Oh My Pi coding agent, a Bun single-file executable that embeds its"
            " own JavaScript runtime; the appliance's entrypoint. The digest is"
            " verified against the release SHA256SUMS before the file is made"
            " executable. Installed to /usr/bin/omp.",
            omp_sha,
        ),
        package(
            "gh",
            gh_version,
            f"https://github.com/cli/cli/releases/download/v{gh_version}/gh_{gh_version}_linux_{GH_ARCH[arch]}.tar.gz",
            f"pkg:github/cli/cli@v{gh_version}",
            "GitHub CLI. The appliance reviews, approves, and merges through it,"
            " so it is a runtime dependency rather than a convenience."
            " Installed to /usr/bin/gh.",
            gh_sha,
        ),
        package(
            "bluefin-review-mode",
            args.version,
            f"https://github.com/projectbluefin/review/tree/{args.revision}/image/extension/bluefin-review",
            f"pkg:github/projectbluefin/review@{args.revision}",
            "The Bluefin Review mode for omp: the extension package and its"
            " companion review agents, copied from this repository at the"
            " recorded revision. Installed to"
            " /usr/share/bluefin/review/extension.",
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--arch", required=True, help="uname -m of the build host")
    parser.add_argument("--version", required=True, help="appliance version, e.g. 26.08.03")
    parser.add_argument("--revision", required=True, help="review source revision")
    parser.add_argument("--out", required=True, type=pathlib.Path, help="output SPDX JSON path")
    parser.add_argument("--omp-version", required=True)
    parser.add_argument("--omp-sha256-x86-64", required=True)
    parser.add_argument("--omp-sha256-aarch64", required=True)
    parser.add_argument("--gh-version", required=True)
    parser.add_argument("--gh-sha256-x86-64", required=True)
    parser.add_argument("--gh-sha256-aarch64", required=True)
    args = parser.parse_args()

    arch = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(args.arch)
    if arch is None:
        raise SystemExit(f"unsupported architecture: {args.arch}")

    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "projectbluefin-review-appliance",
        "documentNamespace": "https://github.com/projectbluefin/review/sbom/"
        f"review-appliance-{args.version}-{args.revision}-{arch}",
        "creationInfo": {
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "creators": ["Tool: projectbluefin-review-generate-appliance-sbom"],
        },
        "packages": build_packages(args, arch),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
