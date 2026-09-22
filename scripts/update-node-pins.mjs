// Renovate post-upgrade task: refresh the Node.js version and
// per-architecture binary digests pinned in the contributor image.
//
// Node.js publishes a signed SHASUMS256.txt per release rather than GitHub
// release assets, so the digest lookup is local to this file; the
// Containerfile rewrite is shared via scripts/lib/release-pins.mjs.

import { createContainerfilePins, runAsScript } from "./lib/release-pins.mjs";

const LABEL = "Node";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseShasums(shasumsText, requestedVersion) {
	const version = requestedVersion.replace(/^v/, "");
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid Node version: ${requestedVersion}`);

	const x64Asset = `node-v${version}-linux-x64.tar.xz`;
	const arm64Asset = `node-v${version}-linux-arm64.tar.xz`;

	let x86_64 = null;
	let aarch64 = null;

	for (const line of shasumsText.split("\n")) {
		const match = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/i);
		if (!match) continue;
		const [, sha, filename] = match;
		if (filename === x64Asset) x86_64 = sha.toLowerCase();
		if (filename === arm64Asset) aarch64 = sha.toLowerCase();
	}

	if (!x86_64 || !SHA256_HEX_PATTERN.test(x86_64)) {
		throw new Error(`Node ${version} missing required ${x64Asset} SHA-256 in SHASUMS256.txt`);
	}
	if (!aarch64 || !SHA256_HEX_PATTERN.test(aarch64)) {
		throw new Error(`Node ${version} missing required ${arm64Asset} SHA-256 in SHASUMS256.txt`);
	}

	return { version, x86_64, aarch64 };
}

async function fetchRelease(requestedVersion, fetchImpl) {
	const version = requestedVersion.replace(/^v/, "");
	const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
	const response = await fetchImpl(url, { redirect: "error" });
	if (!response.ok) throw new Error(`Node release lookup failed: ${response.status} ${response.statusText}`);
	const text = await response.text();
	return parseShasums(text, version);
}

const containerfile = createContainerfilePins({
	label: LABEL,
	argPrefix: "NODE",
	versionPattern: VERSION_PATTERN,
	containerfiles: ["image/contribute/Containerfile"],
});

export const updateContainerfile = containerfile.updateContainerfile;

export function syncNodePins(options = {}) {
	return containerfile.syncPins(fetchRelease, options);
}

runAsScript(import.meta.url, async () => {
	const pins = await syncNodePins({ requestedVersion: process.argv[2] });
	process.stdout.write(`Node ${pins.version}: linux-x64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
});
