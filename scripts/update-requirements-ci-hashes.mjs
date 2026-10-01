import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";

// The full requirement spec, minus the trailing line continuation: name,
// optional extras, version, and an optional PEP 508 environment marker.
// The marker is restricted to the PEP 508 marker charset -- identifiers,
// version-ish literals, quotes, parentheses, and comparison operators -- so a
// head-controlled tail after `;` cannot smuggle anything else (`:` and `/` of a
// URL, `--index-url`'s argument, a `@` direct reference) past this parser and
// into uv's requirements file. Anything outside that charset fails to match and
// the line is refused rather than re-emitted.
// The name follows PEP 508: it must start and end with an alphanumeric, so
// `.`, `_` and `-` are only ever interior. Without those anchors a bare
// `[a-zA-Z0-9._-]+` accepts an option as a name and re-emits option-shaped
// lines (`--index-url==1.0`, `-r==1.0`, `--find-links==1.0`) into the
// requirements file the resolver reads.
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;[a-zA-Z0-9._'"()<>=!~+ \t-]*)?$/;

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

// Only pinned PyPI requirements cross into the resolver: never PR-controlled
// index options, includes, local paths, URLs, or project configuration.
export function compilerInput(source) {
	const specs = [];
	for (const line of source.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#") || /^\s+--hash=sha256:[0-9a-f]{64}(?:\s*\\)?\s*$/.test(line)) continue;
		const requirement = parseRequirement(line);
		if (!requirement || !/^[a-zA-Z0-9._,-]*$/.test(requirement.spec.match(/\[([^\]]*)\]/)?.[1] ?? "")) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${line.trim()}`);
		}
		specs.push(requirement.spec);
	}
	if (specs.length === 0) throw new Error(`${LOCKFILE}: no pinned requirements`);
	return specs.join("\n") + "\n";
}

// PEP 503 normalisation: `Foo_Bar.baz` and `foo-bar-baz` name the same project.
function normalizeName(name) {
	return name.replace(/[-_.]+/g, "-").toLowerCase();
}

// `uv pip compile` without `--universal` resolves for the runner's platform, so
// a pin whose PEP 508 marker is false there is simply absent from the output.
// That silently drops the package from a --require-hashes lockfile, the same
// failure the parser refuses rather than skips. Fail instead.
export function assertAllInputsResolved(input, output) {
	const resolved = new Set();
	for (const line of output.split("\n")) {
		const requirement = parseRequirement(line);
		if (requirement) resolved.add(normalizeName(requirement.name));
	}
	const missing = input
		.split("\n")
		.map((line) => parseRequirement(line))
		.filter((requirement) => requirement && !resolved.has(normalizeName(requirement.name)))
		.map((requirement) => requirement.name);
	if (missing.length > 0) {
		throw new Error(
			`${LOCKFILE}: resolution dropped pinned package(s) ${[...new Set(missing)].join(", ")}; `
			+ "an environment marker excluded them on this platform, so the rewrite would lose them",
		);
	}
}

export async function syncRequirementsCiHashes({ root = process.cwd(), run = promisify(execFile) } = {}) {
	const path = join(root, LOCKFILE);
	const source = await readFile(path, "utf8");
	const input = compilerInput(source);
	const temporary = await mkdtemp(join(tmpdir(), "requirements-ci-"));
	try {
		await writeFile(join(temporary, "requirements.in"), input);
		await run("uv", [
			"--no-config", "pip", "compile", "--no-sources",
			"--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
			"--generate-hashes", "--python-version", "3.13", "--no-header", "--no-annotate",
			"--output-file", "requirements.lock", "requirements.in",
		], { cwd: temporary });
		const compiled = await readFile(join(temporary, "requirements.lock"), "utf8");
		assertAllInputsResolved(input, compiled);
		const updated = "# Pin pre-commit and dependencies with sha256 hashes for CI integrity verification.\n"
			+ "# Compiled via: uv pip compile --no-sources --only-binary :all: --generate-hashes"
			+ " --no-annotate --python-version 3.13\n"
			+ compiled;
		if (updated !== source) await writeFile(path, updated);
		return { path, updated: updated !== source };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

async function main() {
	const result = await syncRequirementsCiHashes();
	process.stdout.write(`requirements-ci.lock: ${result.updated ? "dependencies and hashes updated" : "dependencies and hashes current"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
