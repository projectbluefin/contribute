import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { releasePins, syncOmpPins, updateContainerfile } from "../scripts/update-omp-pins.mjs";

const X64 = "a".repeat(64);
const ARM64 = "b".repeat(64);
const RELEASE = {
	tag_name: "v18.2.1",
	draft: false,
	prerelease: false,
	assets: [
		{ name: "omp-linux-arm64", digest: `sha256:${ARM64}` },
		{ name: "omp-linux-x64", digest: `sha256:${X64}` },
	],
};
const OLD_CONTAINERFILE = `# renovate: datasource=github-releases depName=can1357/oh-my-pi
ARG OMP_VERSION=18.1.22
ARG OMP_X86_64_SHA256=${"1".repeat(64)}
ARG OMP_AARCH64_SHA256=${"2".repeat(64)}
`;
const RENOVATED_CONTAINERFILE = OLD_CONTAINERFILE.replace("18.1.22", "18.2.1");

function response(payload) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => payload,
	};
}

test("releasePins accepts only stable OMP assets with GitHub SHA-256 digests", () => {
	assert.deepEqual(releasePins(RELEASE), { version: "18.2.1", x86_64: X64, aarch64: ARM64 });
	assert.throws(() => releasePins({ ...RELEASE, prerelease: true }), /published stable release/);
	assert.throws(
		() => releasePins({ ...RELEASE, assets: RELEASE.assets.filter((asset) => asset.name !== "omp-linux-arm64") }),
		/no omp-linux-arm64 asset/,
	);
	assert.throws(
		() => releasePins({ ...RELEASE, assets: [{ name: "omp-linux-x64", digest: "" }, RELEASE.assets[0]] }),
		/no valid SHA-256 digest/,
	);
});

test("updateContainerfile replaces exactly one complete OMP pin set", () => {
	const updated = updateContainerfile(OLD_CONTAINERFILE, { version: "18.2.1", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(updated, new RegExp(`^ARG OMP_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_AARCH64_SHA256=${ARM64}$`, "m"));
	assert.throws(() => updateContainerfile(`${OLD_CONTAINERFILE}ARG OMP_VERSION=1.0.0\n`, releasePins(RELEASE)), /expected one ARG OMP_VERSION pin/);
});

test("syncOmpPins updates both shipped images from the same Renovate-selected release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_CONTAINERFILE);
	await writeFile(join(root, "image/contribute/Containerfile"), RENOVATED_CONTAINERFILE);

	const urls = [];
	const pins = await syncOmpPins({
		root,
		fetchImpl: async (url) => {
			urls.push(String(url));
			return response(RELEASE);
		},
	});

	assert.equal(pins.version, "18.2.1");
	assert.deepEqual(urls, ["https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.2.1"]);
	const appliance = await readFile(join(root, "image/appliance/Containerfile"), "utf8");
	const contribute = await readFile(join(root, "image/contribute/Containerfile"), "utf8");
	assert.equal(appliance, contribute);
	assert.match(appliance, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(appliance, new RegExp(`^ARG OMP_X86_64_SHA256=${X64}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_AARCH64_SHA256=${ARM64}$`, "m"));
});

test("Renovate follows OMP releases and both image publishers validate the pin sync", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	const manager = config.customManagers.find((candidate) => candidate.depNameTemplate === "can1357/oh-my-pi");
	assert.ok(manager, "OMP needs a regex manager for ARG OMP_VERSION");
	assert.equal(manager.datasourceTemplate, "github-releases");
	assert.equal(manager.versioningTemplate, "semver-coerced");
	assert.match(manager.matchStrings[0], /ARG OMP_VERSION/);
	const rule = config.packageRules.find((candidate) => candidate.matchPackageNames?.includes("can1357/oh-my-pi"));
	assert.ok(rule, "OMP needs a dedicated Renovate package rule");
	assert.deepEqual(rule.matchDatasources, ["github-releases"]);
	assert.equal(rule.matchManagers, undefined);
	assert.equal(rule.automerge, true);
	assert.equal(rule.automergeType, "pr");
	const currentPinBlock = async (path) => (await readFile(path, "utf8"))
		.split("\n")
		.filter((line) => /^ARG OMP_(?:VERSION|X86_64_SHA256|AARCH64_SHA256)=/.test(line));
	assert.deepEqual(
		await currentPinBlock("image/appliance/Containerfile"),
		await currentPinBlock("image/contribute/Containerfile"),
		"review and contributor images must ship one OMP release",
	);
	assert.equal(rule.automergeStrategy, "squash");
	assert.deepEqual(rule.postUpgradeTasks.commands, ["node scripts/update-omp-pins.mjs"]);
	assert.deepEqual(rule.postUpgradeTasks.fileFilters.sort(), [
		"image/appliance/Containerfile",
		"image/contribute/Containerfile",
	]);

	const renovateWorkflow = await readFile(".github/workflows/renovate.yml", "utf8");
	assert.match(renovateWorkflow, /cron: '15 2 \* \* \*'/);
	assert.match(renovateWorkflow, /RENOVATE_ALLOWED_COMMANDS:.*update-omp-pins/);
	assert.match(renovateWorkflow, /RENOVATE_REPOSITORIES: \$\{\{ github\.repository \}\}/);
	for (const path of [".github/workflows/publish-appliance.yml", ".github/workflows/publish-contribute.yml"]) {
		const workflow = await readFile(path, "utf8");
		assert.match(workflow, /push:\n    branches:\n      - main/);
		assert.match(workflow, /node --test tests\/update-omp-pins\.test\.mjs/);
	}
});

test("every post-upgrade pin synchronizer is handed a GitHub token and runs observably", async () => {
	const workflow = await readFile(".github/workflows/renovate.yml", "utf8");

	// Renovate assembles post-upgrade command environments from its own
	// allowlist, which carries no GitHub credential, so the job's token never
	// reaches the command unless customEnvVariables hands it over. Without it
	// every release lookup is anonymous, the shared runner address exhausts the
	// unauthenticated quota, and the branch lands a version bump with stale
	// digests that only the image build rejects.
	const customEnv = /RENOVATE_CUSTOM_ENV_VARIABLES: '(?<json>\{.*\})'/.exec(workflow)?.groups?.json;
	assert.ok(customEnv, "renovate.yml must hand post-upgrade commands a GitHub token");
	assert.match(customEnv, /steps\.app-token\.outputs\.token/);
	const tokenName = ["RENOVATE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].find((name) => customEnv.includes(`"${name}"`));
	assert.ok(tokenName, "customEnvVariables must carry a variable the pin synchronizers read");
	for (const script of ["omp", "gh", "tmux"]) {
		const source = await readFile(`scripts/update-${script}-pins.mjs`, "utf8");
		assert.match(source, new RegExp(`process\\.env\\.${tokenName}\\b`), `update-${script}-pins.mjs must read ${tokenName}`);
	}

	// Renovate logs post-upgrade compilation, execution, and file filtering at
	// debug. At info a synchronizer that never ran reads exactly like one that
	// succeeded.
	assert.match(workflow, /^ {10}LOG_LEVEL: debug$/m);
});

test("a failed release lookup reports whether the request carried credentials", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_CONTAINERFILE);
	await writeFile(join(root, "image/contribute/Containerfile"), RENOVATED_CONTAINERFILE);

	const tokenNames = ["RENOVATE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
	const saved = Object.fromEntries(tokenNames.map((name) => [name, process.env[name]]));
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	const rateLimited = async () => ({ ok: false, status: 403, statusText: "rate limit exceeded", json: async () => ({}) });
	for (const name of tokenNames) delete process.env[name];
	await assert.rejects(syncOmpPins({ root, fetchImpl: rateLimited }), /403 rate limit exceeded \(anonymous request\)/);

	process.env.GH_TOKEN = "post-upgrade-token";
	await assert.rejects(syncOmpPins({ root, fetchImpl: rateLimited }), /\(authenticated request\)/);
});
