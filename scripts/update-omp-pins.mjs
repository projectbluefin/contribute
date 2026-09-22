// Renovate post-upgrade task: refresh the OMP version and per-architecture
// binary digests pinned in the contributor image.
// Mechanics live in scripts/lib/release-pins.mjs.

import { createContainerfilePins, createGithubReleasePins, runAsScript } from "./lib/release-pins.mjs";

const LABEL = "OMP";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const release = createGithubReleasePins({
	label: LABEL,
	repository: "can1357/oh-my-pi",
	userAgent: "hive-contribute-omp-sync",
	versionPattern: VERSION_PATTERN,
	assetNames: () => ({ x86_64: "omp-linux-x64", aarch64: "omp-linux-arm64" }),
});

const containerfile = createContainerfilePins({
	label: LABEL,
	argPrefix: "OMP",
	versionPattern: VERSION_PATTERN,
	containerfiles: ["image/contribute/Containerfile"],
});

export const releasePins = release.releasePins;
export const updateContainerfile = containerfile.updateContainerfile;

export function syncOmpPins(options = {}) {
	return containerfile.syncPins(release.fetchRelease, options);
}

runAsScript(import.meta.url, async () => {
	const pins = await syncOmpPins({ requestedVersion: process.argv[2] });
	process.stdout.write(`OMP ${pins.version}: linux-x64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
});
