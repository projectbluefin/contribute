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

// One PyPI release, reduced to the two things this script needs: the file
// hashes it re-emits, and the dependency list the completeness check reads.
export async function fetchPackageMetadata(name, version, fetchImpl = fetch) {
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
	const requiresDist = Array.isArray(data.info?.requires_dist) ? data.info.requires_dist : [];
	return { hashes: [...new Set(hashes)].sort(), requiresDist };
}

export async function fetchPackageHashes(name, version, fetchImpl = fetch) {
	const { hashes } = await fetchPackageMetadata(name, version, fetchImpl);
	return hashes;
}

// PyPI reports distribution names as the author typed them; PEP 503 says two
// names comparing equal after this folding are the same project, so the lock's
// `pyyaml` and a dependency's `PyYAML` must not read as a missing package.
export function normalizeName(name) {
	return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

// The interpreter the lock was compiled for, read from the `uv pip compile`
// command line the lock's own header records. Without it, every marker that
// asks about the Python version is unevaluable and its dependency is skipped.
export function lockPythonVersion(source) {
	const match = source.match(/--python-version\s+([0-9]+(?:\.[0-9]+)*)/);
	return match ? match[1] : null;
}

function compareVersions(left, right) {
	const l = left.split(".").map((p) => Number.parseInt(p, 10));
	const r = right.split(".").map((p) => Number.parseInt(p, 10));
	if (l.some(Number.isNaN) || r.some(Number.isNaN)) return null;
	for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
		const diff = (l[i] ?? 0) - (r[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

// Only the environment this lock is installed into: CI runs the container on
// Linux with CPython. Any marker variable outside this table is unknown, and an
// unknown marker never reports a dependency as missing.
const MARKER_ENVIRONMENT = {
	sys_platform: "linux",
	platform_system: "Linux",
	os_name: "posix",
	implementation_name: "cpython",
	platform_python_implementation: "CPython",
};

const VERSION_VARIABLES = new Set(["python_version", "python_full_version", "implementation_version"]);

function tokenizeMarker(marker) {
	const tokens = [];
	let i = 0;
	while (i < marker.length) {
		const char = marker[i];
		if (/\s/.test(char)) { i += 1; continue; }
		if (char === "(" || char === ")") { tokens.push({ type: char }); i += 1; continue; }
		if (char === '"' || char === "'") {
			const end = marker.indexOf(char, i + 1);
			if (end === -1) return null;
			tokens.push({ type: "string", value: marker.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		const operator = marker.slice(i).match(/^(===|==|!=|<=|>=|~=|<|>)/);
		if (operator) { tokens.push({ type: "op", value: operator[1] }); i += operator[1].length; continue; }
		const word = marker.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
		if (!word) return null;
		tokens.push({ type: "word", value: word[0] });
		i += word[0].length;
		continue;
	}
	return tokens;
}

// Three-valued: true, false, or null for "this environment cannot say". Null
// propagates, so a marker holding one unrecognised variable is never read as a
// requirement that must be in the lock.
function and3(a, b) {
	if (a === false || b === false) return false;
	if (a === null || b === null) return null;
	return true;
}

function or3(a, b) {
	if (a === true || b === true) return true;
	if (a === null || b === null) return null;
	return false;
}

function evaluateComparison(left, operator, right) {
	const sides = [left, right].map((token) => {
		if (token.type === "string") return { kind: "literal", value: token.value };
		if (VERSION_VARIABLES.has(token.value)) return { kind: "version", name: token.value };
		if (token.value in MARKER_ENVIRONMENT) return { kind: "literal", value: MARKER_ENVIRONMENT[token.value] };
		return { kind: "unknown" };
	});
	if (sides.some((side) => side.kind === "unknown")) return null;

	const versionSide = sides.find((side) => side.kind === "version");
	if (versionSide) {
		// Only python_version is pinned by the lock header; the rest stay unknown.
		if (versionSide.name !== "python_version") return null;
		const other = sides.find((side) => side !== versionSide);
		if (other.kind !== "literal") return null;
		const pythonVersion = MARKER_ENVIRONMENT.python_version;
		if (!pythonVersion) return null;
		const [a, b] = sides[0] === versionSide ? [pythonVersion, other.value] : [other.value, pythonVersion];
		const order = compareVersions(a, b);
		if (order === null) return null;
		switch (operator) {
			case "==": case "===": return order === 0;
			case "!=": return order !== 0;
			case "<": return order < 0;
			case "<=": return order <= 0;
			case ">": return order > 0;
			case ">=": return order >= 0;
			default: return null;
		}
	}

	const [a, b] = sides.map((side) => side.value);
	switch (operator) {
		case "==": case "===": return a === b;
		case "!=": return a !== b;
		default: return null;
	}
}

function parseMarkerTokens(tokens, start) {
	function parsePrimary(index) {
		const token = tokens[index];
		if (!token) return null;
		if (token.type === "(") {
			const inner = parseOr(index + 1);
			if (!inner || tokens[inner.next]?.type !== ")") return null;
			return { value: inner.value, next: inner.next + 1 };
		}
		const operator = tokens[index + 1];
		const right = tokens[index + 2];
		if (!operator || operator.type !== "op" || !right) return null;
		if (token.type !== "word" && token.type !== "string") return null;
		if (right.type !== "word" && right.type !== "string") return null;
		return { value: evaluateComparison(token, operator.value, right), next: index + 3 };
	}

	function parseAnd(index) {
		let current = parsePrimary(index);
		if (!current) return null;
		while (tokens[current.next]?.type === "word" && tokens[current.next].value === "and") {
			const next = parsePrimary(current.next + 1);
			if (!next) return null;
			current = { value: and3(current.value, next.value), next: next.next };
		}
		return current;
	}

	function parseOr(index) {
		let current = parseAnd(index);
		if (!current) return null;
		while (tokens[current.next]?.type === "word" && tokens[current.next].value === "or") {
			const next = parseAnd(current.next + 1);
			if (!next) return null;
			current = { value: or3(current.value, next.value), next: next.next };
		}
		return current;
	}

	return parseOr(start);
}

// true when this environment must have the dependency installed, false when it
// must not, null when the marker says something this script cannot decide --
// which is treated exactly like false, so the check only ever reports a
// dependency it is sure about.
export function evaluateMarker(marker, pythonVersion = null) {
	if (!marker || marker.trim() === "") return true;
	// An `extra ==` marker gates the dependency on an extra. The lock asks for
	// no extras it does not also pin by name, so these are not required here.
	if (/\bextra\b/.test(marker)) return false;
	const tokens = tokenizeMarker(marker);
	if (!tokens || tokens.length === 0) return null;
	MARKER_ENVIRONMENT.python_version = pythonVersion;
	try {
		const parsed = parseMarkerTokens(tokens, 0);
		if (!parsed || parsed.next !== tokens.length) return null;
		return parsed.value;
	} finally {
		delete MARKER_ENVIRONMENT.python_version;
	}
}

// `virtualenv (>=20.10.0) ; python_version < "3.11"` -> name plus marker.
export function parseDependencySpec(entry) {
	if (typeof entry !== "string") return null;
	const [spec, ...markerParts] = entry.split(";");
	const name = spec.trim().match(/^[A-Za-z0-9._-]+/);
	if (!name) return null;
	return { name: name[0], marker: markerParts.join(";").trim() };
}

// A `--require-hashes` lock must name every package pip will try to install:
// pip refuses the whole install when a resolved dependency has no hash entry,
// so a dependency that appeared upstream since the lock was compiled makes the
// lock unsatisfiable. Re-fetching hashes cannot add it -- the script only
// rewrites pins that are already there -- so say so loudly instead of handing
// back a lock that installs nowhere.
export function missingDependencies(packages, pythonVersion = null) {
	const locked = new Set(packages.map((pkg) => normalizeName(pkg.name)));
	const missing = new Map();
	for (const pkg of packages) {
		for (const entry of pkg.requiresDist ?? []) {
			const dependency = parseDependencySpec(entry);
			if (!dependency) continue;
			if (evaluateMarker(dependency.marker, pythonVersion) !== true) continue;
			const normalized = normalizeName(dependency.name);
			if (locked.has(normalized)) continue;
			if (!missing.has(normalized)) missing.set(normalized, new Set());
			missing.get(normalized).add(pkg.name);
		}
	}
	return [...missing.entries()]
		.map(([name, requiredBy]) => ({ name, requiredBy: [...requiredBy].sort() }))
		.sort((a, b) => a.name.localeCompare(b.name));
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
	const packages = [];

	for (const block of blocks) {
		const requirement = parseRequirement(block[0]);
		// Refuse rather than skip. A skipped block is not left alone: it is
		// omitted from the rewrite, so the package and its hashes vanish from a
		// --require-hashes lockfile with nothing said.
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${block[0].trim()}`);
		}
		const comments = block.filter((l) => l.trim().startsWith("#"));

		const { hashes, requiresDist } = await fetchPackageMetadata(
			requirement.name, requirement.version, fetchImpl);
		packages.push({ name: requirement.name, requiresDist });
		reconstructed += `${requirement.spec} \\\n`;
		hashes.forEach((h, idx) => {
			const isLast = idx === hashes.length - 1;
			reconstructed += `    --hash=sha256:${h}${isLast ? "" : " \\"}\n`;
		});
		if (comments.length > 0) {
			reconstructed += comments.join("\n") + "\n";
		}
	}

	const missing = missingDependencies(packages, lockPythonVersion(source));
	if (missing.length > 0) {
		const detail = missing
			.map(({ name, requiredBy }) => `  ${name} (required by ${requiredBy.join(", ")})`)
			.join("\n");
		throw new Error(
			`${LOCKFILE}: pinned packages now require dependencies the lock does not pin:\n${detail}\n` +
			"This script only refreshes hashes for pins already present, so pip will reject the " +
			"lock under --require-hashes. Recompile it: " +
			"uv pip compile --generate-hashes --python-version 3.13 -");
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
