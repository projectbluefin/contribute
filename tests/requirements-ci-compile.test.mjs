import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertAllInputsResolved, compilerInput, syncRequirementsCiHashes } from "../scripts/update-requirements-ci-hashes.mjs";

test("compiler accepts only pins, extras, markers, comments, and hashes", () => {
	assert.equal(compilerInput('coverage[toml]==7.6.0 ; python_version >= "3.11" \\\n    --hash=sha256:' + "a".repeat(64) + '\n    # via test\n'), 'coverage[toml]==7.6.0 ; python_version >= "3.11"\n');
	assert.equal(compilerInput("a==1.0\nZope.Interface==7.0\nruamel-yaml-clib==0.2.8\n"), "a==1.0\nZope.Interface==7.0\nruamel-yaml-clib==0.2.8\n");
	for (const line of ["--index-url https://evil.example", "-r other.txt", "./package", "pkg @ https://evil.example/pkg.whl", "foo==1.0 invalid", "foo[https://evil.example]==1.0", 'foo==1.0 ; os_name=="x" --index-url https://evil.example', 'foo==1.0 ; os_name=="x" @ https://evil.example/pkg.whl', "foo==1.0 ; os_name=='x' -r /etc/passwd", "--index-url==1.0", "-r==1.0", "-e.==1.0", "--find-links==1.0", "foo-==1.0", ".foo==1.0", "_foo==1.0", "foo.==1.0"]) {
		assert.throws(() => compilerInput(`foo==1.0\n${line}\n`), /cannot parse/);
	}
	assert.throws(() => compilerInput("# empty\n"), /no pinned requirements/);
});

test("a pin missing from the compiled output fails instead of being dropped", () => {
	const hash = `    --hash=sha256:${"a".repeat(64)}\n`;
	// uv without --universal resolves for the runner, so a false marker leaves
	// the package out of the output entirely.
	assert.throws(
		() => assertAllInputsResolved(
			'foo==1.0.0\ntomli==2.0.1 ; python_version < "3.11"\n',
			`foo==1.0.0 \\\n${hash}`,
		),
		/resolution dropped pinned package\(s\) tomli/,
	);
	// PEP 503 says `Zope.Interface` and `zope-interface` are the same project.
	assert.doesNotThrow(() => assertAllInputsResolved(
		"Zope.Interface==7.0\n",
		`zope-interface==7.0 \\\n${hash}`,
	));
});

test("compiler failure leaves the lock intact and removes temporary inputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "ci-lock-test-"));
	let cwd;
	try {
		await writeFile(join(root, "requirements-ci.lock"), "foo==1.0\n");
		await assert.rejects(syncRequirementsCiHashes({ root, run: async (command, args, options) => {
			cwd = options.cwd;
			assert.equal(command, "uv");
			assert.ok(args.includes("--no-config"));
			assert.ok(args.includes("--no-sources"));
			assert.ok(args.includes("--only-binary"));
			assert.equal(await readFile(join(cwd, "requirements.in"), "utf8"), "foo==1.0\n");
			throw new Error("resolution failed");
		} }), /resolution failed/);
		assert.equal(await readFile(join(root, "requirements-ci.lock"), "utf8"), "foo==1.0\n");
		await assert.rejects(readFile(join(cwd, "requirements.in")), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("real uv adds previously absent transitive pins and hashes, preserving the bumped pin", { skip: !process.env.TEST_UV_NETWORK }, async () => {
	const root = await mkdtemp(join(tmpdir(), "ci-lock-test-"));
	try {
		await writeFile(join(root, "requirements-ci.lock"), "virtualenv==20.36.0\n");
		await syncRequirementsCiHashes({ root });
		const lock = await readFile(join(root, "requirements-ci.lock"), "utf8");
		assert.match(lock, /^virtualenv==20\.36\.0/m);
		assert.match(lock, /^distlib==/m);
		assert.match(lock, /^filelock==/m);
		assert.match(lock, /--hash=sha256:[0-9a-f]{64}/);
		assert.equal((await syncRequirementsCiHashes({ root })).updated, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
