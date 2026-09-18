import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONTAINERFILES = ["image/contribute/Containerfile"];
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

function replaceSingle(source, pattern, replacement, path) {
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ${replacement.split("=")[0]} pin`);
	return source.replace(pattern, replacement);
}

function readPinnedVersion(source, path) {
	const matches = [...source.matchAll(/^ARG NODE_VERSION=(.*)$/gm)];
	if (matches.length !== 1) throw new Error(`${path}: expected one ARG NODE_VERSION pin`);
	const version = matches[0][1];
	if (!VERSION_PATTERN.test(version)) throw new Error(`${path}: invalid Node version ${version}`);
	return version;
}

export function updateContainerfile(source, pins, path = "Containerfile") {
	let updated = replaceSingle(source, /^ARG NODE_VERSION=.*$/gm, `ARG NODE_VERSION=${pins.version}`, path);
	updated = replaceSingle(updated, /^ARG NODE_X86_64_SHA256=.*$/gm, `ARG NODE_X86_64_SHA256=${pins.x86_64}`, path);
	return replaceSingle(updated, /^ARG NODE_AARCH64_SHA256=.*$/gm, `ARG NODE_AARCH64_SHA256=${pins.aarch64}`, path);
}

async function fetchRelease(requestedVersion, fetchImpl) {
	const version = requestedVersion.replace(/^v/, "");
	const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
	const response = await fetchImpl(url, { redirect: "error" });
	if (!response.ok) throw new Error(`Node release lookup failed: ${response.status} ${response.statusText}`);
	const text = await response.text();
	return parseShasums(text, version);
}

export async function syncNodePins({ root = process.cwd(), requestedVersion, fetchImpl = fetch } = {}) {
	const files = await Promise.all(CONTAINERFILES.map(async (relativePath) => {
		const path = join(root, relativePath);
		return { relativePath, path, source: await readFile(path, "utf8") };
	}));
	const pinnedVersions = new Set(files.map(({ relativePath, source }) => readPinnedVersion(source, relativePath)));
	const normalized = requestedVersion?.replace(/^v/, "") ?? [...pinnedVersions][0];
	if (!normalized || !VERSION_PATTERN.test(normalized)) throw new Error(`invalid requested Node version: ${requestedVersion}`);
	const pins = await fetchRelease(normalized, fetchImpl);
	for (const { relativePath, path, source } of files) {
		const updated = updateContainerfile(source, pins, relativePath);
		if (updated !== source) await writeFile(path, updated);
	}
	return pins;
}

async function main() {
	const pins = await syncNodePins({ requestedVersion: process.argv[2] });
	process.stdout.write(`Node ${pins.version}: linux-x64 ${pins.x86_64}, linux-arm64 ${pins.aarch64}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
