import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "can1357/oh-my-pi";
const CONTAINERFILES = ["image/appliance/Containerfile", "image/contribute/Containerfile"];
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;

function requireReleaseAsset(release, name) {
	const asset = release.assets?.find((candidate) => candidate.name === name);
	if (!asset) throw new Error(`OMP ${release.tag_name} has no ${name} asset`);
	const digest = DIGEST_PATTERN.exec(asset.digest ?? "");
	if (!digest) throw new Error(`OMP ${release.tag_name} ${name} has no valid SHA-256 digest`);
	return digest[1];
}

export function releasePins(release, requestedVersion) {
	if (!release || release.draft === true || release.prerelease === true) {
		throw new Error("OMP release must be a published stable release");
	}
	const version = String(release.tag_name ?? "").replace(/^v/, "");
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid OMP release tag: ${release.tag_name ?? "missing"}`);
	if (requestedVersion && version !== requestedVersion) {
		throw new Error(`requested OMP ${requestedVersion}, received ${version}`);
	}
	return {
		version,
		x86_64: requireReleaseAsset(release, "omp-linux-x64"),
		aarch64: requireReleaseAsset(release, "omp-linux-arm64"),
	};
}

function replaceSingle(source, pattern, replacement, path) {
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ${replacement.split("=")[0]} pin`);
	return source.replace(pattern, replacement);
}

function readPinnedVersion(source, path) {
	const matches = [...source.matchAll(/^ARG OMP_VERSION=(.*)$/gm)];
	if (matches.length !== 1) throw new Error(`${path}: expected one ARG OMP_VERSION pin`);
	const version = matches[0][1];
	if (!VERSION_PATTERN.test(version)) throw new Error(`${path}: invalid OMP version ${version}`);
	return version;
}

export function updateContainerfile(source, pins, path = "Containerfile") {
	let updated = replaceSingle(source, /^ARG OMP_VERSION=.*$/gm, `ARG OMP_VERSION=${pins.version}`, path);
	updated = replaceSingle(updated, /^ARG OMP_X86_64_SHA256=.*$/gm, `ARG OMP_X86_64_SHA256=${pins.x86_64}`, path);
	return replaceSingle(updated, /^ARG OMP_AARCH64_SHA256=.*$/gm, `ARG OMP_AARCH64_SHA256=${pins.aarch64}`, path);
}

async function fetchRelease(requestedVersion, fetchImpl) {
	const suffix = `tags/v${requestedVersion}`;
	const token = process.env.RENOVATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "projectbluefin-review-omp-sync",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/${suffix}`, {
		headers,
		redirect: "error",
	});
	if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
	return releasePins(await response.json(), requestedVersion);
}

export async function syncOmpPins({ root = process.cwd(), requestedVersion, fetchImpl = fetch } = {}) {
	const files = await Promise.all(CONTAINERFILES.map(async (relativePath) => {
		const path = join(root, relativePath);
		return { relativePath, path, source: await readFile(path, "utf8") };
	}));
	const pinnedVersions = new Set(files.map(({ relativePath, source }) => readPinnedVersion(source, relativePath)));
	const normalized = requestedVersion?.replace(/^v/, "") ?? [...pinnedVersions][0];
	if (!normalized || !VERSION_PATTERN.test(normalized)) throw new Error(`invalid requested OMP version: ${requestedVersion}`);
	if (!requestedVersion && pinnedVersions.size !== 1) {
		throw new Error(`OMP versions differ across shipped images: ${[...pinnedVersions].join(", ")}`);
	}
	const pins = await fetchRelease(normalized, fetchImpl);
	for (const { relativePath, path, source } of files) {
		const updated = updateContainerfile(source, pins, relativePath);
		if (updated !== source) await writeFile(path, updated);
	}
	return pins;
}

async function main() {
	const pins = await syncOmpPins({ requestedVersion: process.argv[2] });
	process.stdout.write(`OMP ${pins.version}: linux-x64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
