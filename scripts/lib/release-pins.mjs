// One implementation of "rewrite a version + per-architecture SHA-256 pin set
// in the contributor Containerfile", shared by every Renovate post-upgrade
// task in scripts/.
//
// The four syncers (OMP, GitHub CLI, Node.js, tmux) were copies of one
// another. They had already drifted: the guard that refuses to run when the
// tracked Containerfiles disagree about the pinned version existed in the OMP
// and GH copies and was missing from the Node and tmux ones. A pin syncer that
// silently does the wrong thing is how the image supply chain goes stale
// without anything failing, so the behaviour lives in one place.
//
// Each scripts/update-*-pins.mjs keeps its own module identity and exported
// names; only the mechanics are shared.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;

function replaceSingle(source, pattern, replacement, path) {
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ${replacement.split("=")[0]} pin`);
	return source.replace(pattern, replacement);
}

// The Containerfile side: read the currently pinned version, and rewrite the
// version plus both architecture digests as one set.
export function createContainerfilePins({ label, argPrefix, versionPattern, containerfiles }) {
	const versionArg = `${argPrefix}_VERSION`;

	function readPinnedVersion(source, path) {
		const matches = [...source.matchAll(new RegExp(`^ARG ${versionArg}=(.*)$`, "gm"))];
		if (matches.length !== 1) throw new Error(`${path}: expected one ARG ${versionArg} pin`);
		const version = matches[0][1];
		if (!versionPattern.test(version)) throw new Error(`${path}: invalid ${label} version ${version}`);
		return version;
	}

	function updateContainerfile(source, pins, path = "Containerfile") {
		let updated = replaceSingle(source, new RegExp(`^ARG ${versionArg}=.*$`, "gm"), `ARG ${versionArg}=${pins.version}`, path);
		updated = replaceSingle(updated, new RegExp(`^ARG ${argPrefix}_X86_64_SHA256=.*$`, "gm"), `ARG ${argPrefix}_X86_64_SHA256=${pins.x86_64}`, path);
		return replaceSingle(updated, new RegExp(`^ARG ${argPrefix}_AARCH64_SHA256=.*$`, "gm"), `ARG ${argPrefix}_AARCH64_SHA256=${pins.aarch64}`, path);
	}

	// resolvePins(version, fetchImpl) turns a version into
	// { version, x86_64, aarch64 }; where those digests come from is the
	// dependency's business, not this module's.
	async function syncPins(resolvePins, { root = process.cwd(), requestedVersion, fetchImpl = fetch } = {}) {
		const files = await Promise.all(containerfiles.map(async (relativePath) => {
			const path = join(root, relativePath);
			return { relativePath, path, source: await readFile(path, "utf8") };
		}));
		const pinnedVersions = new Set(files.map(({ relativePath, source }) => readPinnedVersion(source, relativePath)));
		const normalized = requestedVersion?.replace(/^v/, "") ?? [...pinnedVersions][0];
		if (!normalized || !versionPattern.test(normalized)) throw new Error(`invalid requested ${label} version: ${requestedVersion}`);
		if (!requestedVersion && pinnedVersions.size !== 1) {
			throw new Error(`${label} versions differ across shipped images: ${[...pinnedVersions].join(", ")}`);
		}
		const pins = await resolvePins(normalized, fetchImpl);
		for (const { relativePath, path, source } of files) {
			const updated = updateContainerfile(source, pins, relativePath);
			if (updated !== source) await writeFile(path, updated);
		}
		return pins;
	}

	return { readPinnedVersion, updateContainerfile, syncPins };
}

// The GitHub-releases side: OMP, GitHub CLI, and tmux all publish tagged
// stable releases carrying per-architecture assets with SHA-256 digests.
export function createGithubReleasePins({ label, repository, userAgent, versionPattern, assetNames }) {
	function requireReleaseAsset(release, name) {
		const asset = release.assets?.find((candidate) => candidate.name === name);
		if (!asset) throw new Error(`${label} ${release.tag_name} has no ${name} asset`);
		const digest = DIGEST_PATTERN.exec(asset.digest ?? "");
		if (!digest) throw new Error(`${label} ${release.tag_name} ${name} has no valid SHA-256 digest`);
		return digest[1];
	}

	function releasePins(release, requestedVersion) {
		if (!release || release.draft === true || release.prerelease === true) {
			throw new Error(`${label} release must be a published stable release`);
		}
		const version = String(release.tag_name ?? "").replace(/^v/, "");
		if (!versionPattern.test(version)) throw new Error(`invalid ${label} release tag: ${release.tag_name ?? "missing"}`);
		if (requestedVersion && version !== requestedVersion) {
			throw new Error(`requested ${label} ${requestedVersion}, received ${version}`);
		}
		const { x86_64, aarch64 } = assetNames(version);
		return {
			version,
			x86_64: requireReleaseAsset(release, x86_64),
			aarch64: requireReleaseAsset(release, aarch64),
		};
	}

	async function fetchRelease(requestedVersion, fetchImpl) {
		const suffix = `tags/v${requestedVersion}`;
		const token = process.env.RENOVATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
		const headers = {
			Accept: "application/vnd.github+json",
			"User-Agent": userAgent,
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (token) headers.Authorization = `Bearer ${token}`;
		const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/${suffix}`, {
			headers,
			redirect: "error",
		});
		if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
		return releasePins(await response.json(), requestedVersion);
	}

	return { releasePins, fetchRelease };
}

// Run `main` only when this module is the process entry point, and report a
// failure as a message plus a non-zero exit code rather than a stack trace.
export function runAsScript(moduleUrl, main) {
	if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
