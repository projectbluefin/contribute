import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
// CI installs pre-commit; # via comments and unannotated entries are not roots.
// uv is a root as well: the workflows that recompile this lock need the
// compiler itself, and pinning it here is what lets them install it with
// --require-hashes instead of an unverified PyPI download.
const ROOT_PACKAGES = ["pre-commit", "uv"];
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9][a-zA-Z0-9._-]*)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;.*)?$/;

// uv lists the constraints file among each package's `# via` sources. That
// source is this lockfile itself, fed back in as pins, so persisting it would
// leak a temp path and make the committed lock differ from what a rerun
// produces. Drop those entries and restore uv's one-source formatting.
export function stripConstraintAnnotations(output, constraints) {
	const lines = output.split("\n");
	const result = [];
	for (let index = 0; index < lines.length; index += 1) {
		const via = lines[index].match(/^(?<indent>\s*)# via(?: (?<inline>.+))?$/);
		if (!via) {
			result.push(lines[index]);
			continue;
		}
		const { indent, inline } = via.groups;
		const sources = [];
		if (inline) sources.push(inline);
		else {
			while (index + 1 < lines.length) {
				const source = lines[index + 1].match(/^\s*#   (.+)$/);
				if (!source) break;
				sources.push(source[1]);
				index += 1;
			}
		}
		const kept = sources.filter((source) => source !== `-c ${constraints}`);
		if (kept.length === 0) continue;
		if (kept.length === 1) {
			result.push(`${indent}# via ${kept[0]}`);
			continue;
		}
		result.push(`${indent}# via`);
		for (const source of kept) result.push(`${indent}#   ${source}`);
	}
	return result.join("\n");
}

export function parseRequirement(line) {
	const spec = line.replace(/\s*\\\s*$/, "").trim();
	const match = spec.match(REQUIREMENT_PATTERN);
	if (!match) return null;
	const { name, extras = "", version, marker = "" } = match.groups;
	return { name, version, spec: `${name}${extras}==${version}${marker}` };
}

export async function updateLockfileContent(source, runImpl = spawnSync) {
	const requirements = [];
	const header = [];
	for (const line of source.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) {
			if (requirements.length === 0) header.push(line);
			continue;
		}
		if (/^\s+--hash=sha256:[0-9a-f]{64}(?:\s*\\)?\s*$/.test(line)) continue;
		const requirement = parseRequirement(line);
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${line.trim()}`);
		}
		requirements.push(requirement);
	}
	if (requirements.length === 0) return source;

	const roots = ROOT_PACKAGES.map((name) => {
		const requirement = requirements.find((entry) => entry.name.toLowerCase().replace(/[_.]+/g, "-") === name);
		if (!requirement) throw new Error(`${LOCKFILE}: missing CI root ${name}`);
		return requirement.spec;
	});
	// Constraints retain Renovate's pins only while a package is still needed.
	// Extras belong on root requirements, not in uv's constraints file.
	const directory = await mkdtemp(join(tmpdir(), "ci-lock-"));
	try {
		const constraints = join(directory, "constraints.txt");
		await writeFile(constraints, `${requirements.map((entry) => entry.spec.replace(/\[[^\]]*\]/, "")).join("\n")}\n`);
		// Only sanitized pins cross the PR boundary: no config or build hooks.
		const result = await runImpl(
			"uv",
			[
				"--no-config", "pip", "compile", "-", "--generate-hashes",
				"--python-version", "3.13", "--only-binary", ":all:",
				"--default-index", "https://pypi.org/simple", "--no-header",
				"--constraint", constraints,
			],
			{
				input: `${roots.join("\n")}\n`,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`${LOCKFILE}: dependency resolution failed: ${result.stderr}`);
		}
		if (!result.stdout.trim()) throw new Error(`${LOCKFILE}: resolver produced an empty lockfile`);
		// uv annotates constraint sources; that annotation names this very
		// lockfile by its temp path, so it never reaches the committed file.
		return `${header.join("\n")}\n${stripConstraintAnnotations(result.stdout, constraints)}`;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function syncRequirementsCiHashes({ root = process.cwd(), runImpl = spawnSync } = {}) {
	const path = join(root, LOCKFILE);
	const source = await readFile(path, "utf8");
	const updated = await updateLockfileContent(source, runImpl);
	if (updated !== source) await writeFile(path, updated);
	return { path, updated: updated !== source };
}

async function main() {
	const result = await syncRequirementsCiHashes();
	process.stdout.write(`requirements-ci.lock: ${result.updated ? "lock recompiled" : "lock current"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
