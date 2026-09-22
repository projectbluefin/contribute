// Renovate post-upgrade task: refresh the tmux static-build version and
// per-architecture binary digests pinned in the contributor image.
// Mechanics live in scripts/lib/release-pins.mjs.

import { createContainerfilePins, createGithubReleasePins, runAsScript } from "./lib/release-pins.mjs";

const LABEL = "tmux";
const VERSION_PATTERN = /^\d+\.\d+[a-z]?$/;

const release = createGithubReleasePins({
	label: LABEL,
	repository: "tmux/tmux-builds",
	userAgent: "hive-contribute-tmux-sync",
	versionPattern: VERSION_PATTERN,
	assetNames: (version) => ({
		x86_64: `tmux-${version}-linux-x86_64.tar.gz`,
		aarch64: `tmux-${version}-linux-arm64.tar.gz`,
	}),
});

const containerfile = createContainerfilePins({
	label: LABEL,
	argPrefix: "TMUX",
	versionPattern: VERSION_PATTERN,
	containerfiles: ["image/contribute/Containerfile"],
});

export const releasePins = release.releasePins;
export const updateContainerfile = containerfile.updateContainerfile;

export function syncTmuxPins(options = {}) {
	return containerfile.syncPins(release.fetchRelease, options);
}

runAsScript(import.meta.url, async () => {
	const pins = await syncTmuxPins({ requestedVersion: process.argv[2] });
	process.stdout.write(`tmux ${pins.version}: linux-x86_64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
});
