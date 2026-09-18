import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

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
	const firstPkgMatch = source.match(/^[a-zA-Z0-9._-]+==/m);
	if (!firstPkgMatch) return source;
	const firstPkgIndex = firstPkgMatch.index;
	const header = source.slice(0, firstPkgIndex);
	const packagesPart = source.slice(firstPkgIndex);

	const blocks = packagesPart.trim().split(/(?=\n[a-zA-Z0-9._-]+==)/g);
	let reconstructed = header;

	for (const rawBlock of blocks) {
		const block = rawBlock.trim();
		const match = block.match(/^([a-zA-Z0-9._-]+)==([0-9][a-zA-Z0-9._!*+-]*)/m);
		if (!match) continue;
		const name = match[1];
		const version = match[2];
		const comments = block
			.split("\n")
			.filter((l) => l.trim().startsWith("#"));

		const hashes = await fetchPackageHashes(name, version, fetchImpl);
		reconstructed += `${name}==${version} \\\n`;
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
