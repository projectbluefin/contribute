import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// A line that starts a requirement. Extras are part of the name, so
// `coverage[toml]==7.6.0` has to be recognised here; a requirement this misses
// is folded into the previous package's block and disappears from the rewrite.
// Hash and comment lines are indented, so they can never match.
const REQUIREMENT_START_PATTERN = /^[a-zA-Z0-9._-]+(?:\[[^\]\n]*\])?\s*==/;

// The full requirement spec, minus the trailing line continuation: name,
// optional extras, version, and an optional PEP 508 environment marker.
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9._-]+)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;.*)?$/;

// Parses one requirement line into the PyPI lookup key and the spec to re-emit.
// `spec` is rebuilt rather than reused verbatim so the rewrite keeps extras and
// the environment marker, which decide whether the package installs at all.
export function parseRequirement(line) {
	const spec = line.replace(/\s*\\\s*$/, "").trim();
	const match = spec.match(REQUIREMENT_PATTERN);
	if (!match) return null;
	const { name, extras = "", version, marker = "" } = match.groups;
	return { name, version, spec: `${name}${extras}==${version}${marker}` };
}

export async function fetchPackageHashes(name, version, fetchImpl = fetch) {
	const url = `https://pypi.org/pypi/${name}/${version}/json`;
	const response = await fetchImpl(url);
	if (!response.ok) {
		throw new Error(`PyPI metadata lookup failed for ${name}==${version}: ${response.status} ${response.statusText}`);
	}
	const data = await response.json();
	if (!Array.isArray(data.urls) || data.urls.length === 0) {
		throw new Error(`No release files found on PyPI for ${name}==${version}`);
	}
	const hashes = data.urls
		.map((u) => u.digests?.sha256)
		.filter((h) => typeof h === "string" && SHA256_HEX_PATTERN.test(h));
	if (hashes.length === 0) {
		throw new Error(`No valid SHA-256 hashes found on PyPI for ${name}==${version}`);
	}
	return [...new Set(hashes)].sort();
}

export async function updateLockfileContent(source, fetchImpl = fetch) {
	const lines = source.split("\n");
	const firstIndex = lines.findIndex((line) => REQUIREMENT_START_PATTERN.test(line));
	if (firstIndex === -1) return source;

	const header = lines.slice(0, firstIndex).map((line) => `${line}\n`).join("");

	const blocks = [];
	for (const line of lines.slice(firstIndex)) {
		if (REQUIREMENT_START_PATTERN.test(line)) blocks.push([line]);
		else blocks[blocks.length - 1].push(line);
	}

	let reconstructed = header;

	for (const block of blocks) {
		const requirement = parseRequirement(block[0]);
		// Refuse rather than skip. A skipped block is not left alone: it is
		// omitted from the rewrite, so the package and its hashes vanish from a
		// --require-hashes lockfile with nothing said.
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${block[0].trim()}`);
		}
		const comments = block.filter((l) => l.trim().startsWith("#"));

		const hashes = await fetchPackageHashes(requirement.name, requirement.version, fetchImpl);
		reconstructed += `${requirement.spec} \\\n`;
		hashes.forEach((h, idx) => {
			const isLast = idx === hashes.length - 1;
			reconstructed += `    --hash=sha256:${h}${isLast ? "" : " \\"}\n`;
		});
		if (comments.length > 0) {
			reconstructed += comments.join("\n") + "\n";
		}
	}

	return reconstructed;
}

export async function syncRequirementsCiHashes({ root = process.cwd(), fetchImpl = fetch } = {}) {
	const path = join(root, LOCKFILE);
	const source = await readFile(path, "utf8");
	const updated = await updateLockfileContent(source, fetchImpl);
	if (updated !== source) {
		await writeFile(path, updated);
	}
	return { path, updated: updated !== source };
}

async function main() {
	const result = await syncRequirementsCiHashes();
	process.stdout.write(`requirements-ci.lock: ${result.updated ? "hashes updated" : "hashes current"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
