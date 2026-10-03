import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9._-]+)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;.*)?$/;

export function parseRequirement(line) {
	const spec = line.replace(/\s*\\\s*$/, "").trim();
	const match = spec.match(REQUIREMENT_PATTERN);
	if (!match) return null;
	const { name, extras = "", version, marker = "" } = match.groups;
	return { name, version, spec: `${name}${extras}==${version}${marker}` };
}

// `# via` is the only record of which entries are this project's own asks and
// which uv pulled in for something else. A source of `-r <file>` or
// `-c <file>` names the input the requirement was read from, not a package
// that depends on it, so it leaves the entry direct.
const VIA_LINE = /^#\s*via(?:\s+(?<inline>\S.*))?$/;
const VIA_SOURCE = /^#\s{2,}(?<source>\S.*)$/;
const VIA_FILE_SOURCE = /^-[rc]\s/;

export function splitLockfile(source) {
	const header = [];
	const entries = [];
	const lines = source.split("\n");
	let current = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed) {
			if (entries.length === 0) header.push(line);
			continue;
		}
		if (trimmed.startsWith("#")) {
			if (entries.length === 0) {
				header.push(line);
				continue;
			}
			const via = VIA_LINE.exec(trimmed);
			if (!current || !via) continue;
			const sources = [];
			if (via.groups.inline) {
				sources.push(via.groups.inline.trim());
			} else {
				while (i + 1 < lines.length) {
					const next = VIA_SOURCE.exec(lines[i + 1].trim());
					if (!next) break;
					sources.push(next.groups.source.trim());
					i += 1;
				}
			}
			if (sources.some((entry) => !VIA_FILE_SOURCE.test(entry))) current.direct = false;
			continue;
		}
		if (/^\s+--hash=sha256:[0-9a-f]{64}(?:\s*\\)?\s*$/.test(line)) continue;
		const requirement = parseRequirement(line);
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${line.trim()}`);
		}
		current = { spec: requirement.spec, direct: true };
		entries.push(current);
	}
	return { header, entries };
}

// A lockfile that carries no `# via` annotations at all (one compiled with
// --no-annotate, or hand-written) says nothing about which entries are
// transitive, so every entry has to stay a requirement.
function partition(entries) {
	const direct = entries.filter((entry) => entry.direct);
	if (direct.length === entries.length || direct.length === 0) {
		return { requirements: entries.map((entry) => entry.spec), constraints: [] };
	}
	return {
		requirements: direct.map((entry) => entry.spec),
		constraints: entries.filter((entry) => !entry.direct).map((entry) => entry.spec),
	};
}

// uv records where each requirement came from, including the scratch
// constraints file: `# via\n#   -c /tmp/requirements-ci-XXXX/constraints.txt`.
// That path is different on every run, so left in it would churn the lockfile
// and leak the runner's temporary directory into a committed file.
export function stripConstraintAnnotations(output) {
	const lines = output.split("\n");
	const result = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const via = /^(?<indent>\s*)#\s*via(?<inline>\s+\S.*)?$/.exec(line);
		if (!via) {
			result.push(line);
			continue;
		}
		const { indent, inline } = via.groups;
		const sources = [];
		if (inline) {
			sources.push(inline.trim());
		} else {
			while (i + 1 < lines.length) {
				const next = /^\s*#\s{2,}(?<source>\S.*)$/.exec(lines[i + 1]);
				if (!next) break;
				sources.push(next.groups.source.trim());
				i += 1;
			}
		}
		const kept = sources.filter((source) => !source.startsWith("-c "));
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

export async function updateLockfileContent(source, runImpl = spawnSync) {
	const { header, entries } = splitLockfile(source);
	if (entries.length === 0) return source;
	const { requirements, constraints } = partition(entries);

	// Transitive pins are replayed as constraints, not as requirements. As
	// requirements they were permanent: a transitive dependency nothing depends
	// on any more stayed in the lock forever, and one whose new version
	// disagreed with the old pin deadlocked resolution until someone hand-edited
	// the file. A constraint binds the version only while something still asks
	// for the package, and is ignored once nothing does.
	const scratch = constraints.length > 0 ? await mkdtemp(join(tmpdir(), "requirements-ci-")) : null;
	try {
		const args = [
			"--no-config", "pip", "compile", "-", "--generate-hashes",
			"--python-version", "3.13", "--only-binary", ":all:",
			// Annotations stay on: the lockfile already carries the `# via`
			// lines, they are what tells requirements from transitive pins on
			// the next run, and --no-annotate would rewrite every block of the
			// file on the first run for no gain.
			"--default-index", "https://pypi.org/simple", "--no-header",
		];
		if (scratch) {
			const constraintsPath = join(scratch, "constraints.txt");
			await writeFile(constraintsPath, `${constraints.join("\n")}\n`);
			args.push("--constraint", constraintsPath);
		}

		// Resolve the complete closure, keeping Renovate's pins. Only sanitized
		// requirements cross the PR boundary: no config, indexes, or build hooks.
		const result = runImpl("uv", args, {
			input: `${requirements.join("\n")}\n`,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
		if (result.error) {
			if (result.error.code === "ENOENT") {
				throw new Error(
					`${LOCKFILE}: uv was not found on PATH. The lockfile compiler is a prerequisite of this script; install uv and run it again.`,
				);
			}
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`${LOCKFILE}: dependency resolution failed: ${result.stderr}`);
		}
		if (!result.stdout.trim()) throw new Error(`${LOCKFILE}: resolver produced an empty lockfile`);
		return `${header.join("\n")}\n${stripConstraintAnnotations(result.stdout)}`;
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
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
