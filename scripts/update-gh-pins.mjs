// Renovate post-upgrade task: refresh the GitHub CLI version and
// per-architecture binary digests pinned in the contributor image.
// Mechanics live in scripts/lib/release-pins.mjs.

import { createContainerfilePins, createGithubReleasePins, runAsScript } from "./lib/release-pins.mjs";

const LABEL = "GH";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const release = createGithubReleasePins({
	label: LABEL,
	repository: "cli/cli",
	userAgent: "hive-contribute-gh-sync",
	versionPattern: VERSION_PATTERN,
	assetNames: (version) => ({
		x86_64: `gh_${version}_linux_amd64.tar.gz`,
		aarch64: `gh_${version}_linux_arm64.tar.gz`,
	}),
});

const containerfile = createContainerfilePins({
	label: LABEL,
	argPrefix: "GH",
	versionPattern: VERSION_PATTERN,
	containerfiles: ["image/contribute/Containerfile"],
});

export const releasePins = release.releasePins;
export const updateContainerfile = containerfile.updateContainerfile;

export function syncGhPins(options = {}) {
	return containerfile.syncPins(release.fetchRelease, options);
}

runAsScript(import.meta.url, async () => {
	const pins = await syncGhPins({ requestedVersion: process.argv[2] });
	process.stdout.write(`GH ${pins.version}: linux-amd64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
});
