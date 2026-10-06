import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
const COMMAND = "node scripts/update-requirements-ci-hashes.mjs";

// Recompiling, not re-hashing. Rewriting hashes for the lines already pinned
// cannot add a package that a bumped release newly requires (virtualenv
// 21.14 pulls in packaging, #733), and pip --require-hashes then rejects the
// install because that package has no pinned hash. uv resolves the whole
// tree: the existing pins in --output-file are its preferences, so every
// version Renovate wrote is kept while it still satisfies the resolution,
// and new or dropped dependencies appear or disappear with their hashes.
//
// The preferences are handed over without their hashes. uv reuses a hash it
// finds beside a preferred pin, and after a Renovate bump that hash belongs
// to the previous release.
//
// --no-build: metadata comes from wheels and PyPI only, never from running a
//   source distribution's build backend. The pull_request_target repair job
//   must not execute anything the lockfile names.
// --no-config: the repair job runs in the pull request head's checkout, so a
//   uv.toml or pyproject.toml there must not redirect the index.
export function uvCompileArgs(outputFile) {
	return [
		"pip",
		"compile",
		"--generate-hashes",
		"--python-version",
		"3.13",
		"--no-build",
		"--no-config",
		"--quiet",
		"--custom-compile-command",
		COMMAND,
		"--output-file",
		outputFile,
		"-",
	];
}

// A line that starts a requirement. Extras are part of the name, so
// `coverage[toml]==7.6.0` has to be recognised here. Hash and comment lines
// are indented, so they can never match.
const REQUIREMENT_START_PATTERN = /^[a-zA-Z0-9._-]+(?:\[[^\]\n]*\])?\s*==/;

// The full requirement spec, minus the trailing line continuation: name,
// optional extras, version, and an optional PEP 508 environment marker.
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9._-]+)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;.*)?$/;

// Parses one requirement line into the spec to feed back to the resolver.
// Extras and the environment marker are kept: they decide what installs.
export function parseRequirement(line) {
	const spec = line.replace(/\s*\\\s*$/, "").trim();
	const match = spec.match(REQUIREMENT_PATTERN);
	if (!match) return null;
	const { name, extras = "", version, marker = "" } = match.groups;
	return { name, version, spec: `${name}${extras}==${version}${marker}` };
}

// The pins alone, one per line, with every hash and line continuation removed.
export function stripHashes(source) {
	return source
		.split("\n")
		.filter((line) => !/^\s*--hash=/.test(line))
		.map((line) => line.replace(/\s*\\\s*$/, ""))
		.join("\n");
}

// The requirements the lockfile is compiled from. uv annotates every
// transitive pin with `# via <parent>` and leaves a requirement read from
// stdin unannotated, so the unannotated pins are the direct ones, at the
// versions Renovate bumped them to.
export function directRequirements(source) {
	const blocks = [];
	for (const line of source.split("\n")) {
		if (REQUIREMENT_START_PATTERN.test(line)) blocks.push([line]);
		else if (blocks.length > 0) blocks[blocks.length - 1].push(line);
	}
	const direct = [];
	for (const block of blocks) {
		const requirement = parseRequirement(block[0]);
		// Refuse rather than skip: a direct requirement dropped here is dropped
		// from the recompiled lockfile too.
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${block[0].trim()}`);
		}
		if (!block.some((line) => /^\s*#\s*via\b/.test(line))) direct.push(requirement.spec);
	}
	if (direct.length === 0) {
		throw new Error(`${LOCKFILE}: no direct requirement (a pin without a "# via" annotation) to compile from`);
	}
	return direct;
}

export function runUv(args, { cwd, input }) {
	const result = spawnSync("uv", args, { cwd, input, encoding: "utf8" });
	if (result.error) {
		throw new Error(`cannot run uv: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`uv ${args.slice(0, 2).join(" ")} failed with exit status ${result.status}:\n${result.stderr}`);
	}
}

export async function syncRequirementsCiHashes({ root = process.cwd(), run = runUv } = {}) {
	const path = join(root, LOCKFILE);
	const source = await readFile(path, "utf8");
	const input = `${directRequirements(source).join("\n")}\n`;
	// Compiled beside, not in place: a failed resolution leaves the lockfile
	// exactly as it was.
	const scratch = await mkdtemp(join(tmpdir(), "requirements-ci-"));
	try {
		const output = join(scratch, LOCKFILE);
		await writeFile(output, stripHashes(source));
		run(uvCompileArgs(output), { cwd: root, input });
		const updated = await readFile(output, "utf8");
		if (updated !== source) await writeFile(path, updated);
		return { path, updated: updated !== source };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function main() {
	const result = await syncRequirementsCiHashes();
	process.stdout.write(`${LOCKFILE}: ${result.updated ? "recompiled" : "current"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
