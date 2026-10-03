import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripConstraintAnnotations, updateLockfileContent } from "../scripts/update-requirements-ci-hashes.mjs";

// uv names the constraints file as a `# via` source of every package it pins.
// That file is this lockfile itself, written to a temp path, so persisting the
// annotation would leak the path and leave the committed lock different from
// what the next run produces.
test("the constraints file never appears as a dependency source", () => {
	const constraints = "/tmp/ci-lock-abc123/constraints.txt";
	const output = [
		"cfgv==3.5.0",
		"    # via",
		`    #   -c ${constraints}`,
		"    #   pre-commit",
		"filelock==4.0.7",
		"    # via",
		`    #   -c ${constraints}`,
		"    #   python-discovery",
		"    #   virtualenv",
		"pre-commit==4.6.2",
		`    # via -c ${constraints}`,
		"",
	].join("\n");

	assert.equal(
		stripConstraintAnnotations(output, constraints),
		[
			"cfgv==3.5.0",
			"    # via pre-commit",
			"filelock==4.0.7",
			"    # via",
			"    #   python-discovery",
			"    #   virtualenv",
			"pre-commit==4.6.2",
			"",
		].join("\n"),
	);
});

// The committed lock is what CI installs and what Renovate's branches start
// from. If it is not already what this script emits, the first refresh rewrites
// every block and the repair commit buries the actual version bump.
test("the committed requirements-ci.lock is already what a refresh produces", {
	skip: !process.env.CI_LOCK_UV_TEST,
}, async () => {
	const source = await readFile("requirements-ci.lock", "utf8");
	assert.equal(await updateLockfileContent(source), source);
});

// Opt in to the real uv/PyPI regression; unit tests need neither tool nor network.
test("real uv prunes obsolete pins instead of treating them as dependencies", {
	skip: !process.env.CI_LOCK_UV_TEST,
}, async () => {
	const source = await readFile("requirements-ci.lock", "utf8");
	// An obsolete pin must not even need a published version to resolve.
	const updated = await updateLockfileContent(`${source}\nunused-ci-dependency==999.0.0\n    # via pre-commit\nunannotated-ci-dependency==999.0.0\n`);
	assert.doesNotMatch(updated, /unused-ci-dependency|unannotated-ci-dependency/);
	assert.equal(updated.match(/^pre-commit==[^\s]+/m)?.[0], source.match(/^pre-commit==[^\s]+/m)?.[0]);
	assert.match(updated, /^virtualenv==/m);
	assert.match(updated, /--hash=sha256:[0-9a-f]{64}/);
	assert.equal(await updateLockfileContent(updated), updated);
	// A needed package must still obey its Renovate pin, not silently upgrade.
	await assert.rejects(
		() => updateLockfileContent(source.replace(/^cfgv==[^\s]+/m, "cfgv==999.0.0")),
		/dependency resolution failed/,
	);
});

// The repair job recompiles the lock while holding contents: write on a
// pull_request_target event, so its compiler decides what the hashed lock says.
// Pinning uv here with hashes is what lets those jobs install the compiler with
// `pip install --require-hashes` instead of an unverified PyPI download.
test("uv is pinned with hashes so the compiler itself is verifiable", async () => {
	const lock = await readFile("requirements-ci.lock", "utf8");
	assert.match(lock, /^uv==[0-9][^\s]*\s*\\\n(?:\s+--hash=sha256:[0-9a-f]{64})/m);
});
