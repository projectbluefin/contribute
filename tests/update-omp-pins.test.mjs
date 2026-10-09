import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createContainerfilePins } from "../scripts/lib/release-pins.mjs";
import { releasePins, syncOmpPins, updateContainerfile } from "../scripts/update-omp-pins.mjs";

const OMP_SCRIPT = fileURLToPath(new URL("../scripts/update-omp-pins.mjs", import.meta.url));
const TOKEN_VARIABLES = ["RENOVATE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

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

test("releasePins refuses a draft, a bad tag, or a release other than the one requested", () => {
	assert.deepEqual(releasePins(RELEASE, "18.2.1"), { version: "18.2.1", x86_64: X64, aarch64: ARM64 });
	assert.throws(() => releasePins(RELEASE, "18.2.0"), /requested OMP 18\.2\.0, received 18\.2\.1/);
	assert.throws(() => releasePins({ ...RELEASE, draft: true }), /published stable release/);
	assert.throws(() => releasePins(undefined), /published stable release/);
	assert.throws(() => releasePins({ ...RELEASE, tag_name: "v18.2" }), /invalid OMP release tag: v18\.2/);
	assert.throws(() => releasePins({ ...RELEASE, tag_name: undefined }), /invalid OMP release tag: missing/);
	assert.throws(
		() => releasePins({ ...RELEASE, assets: [{ name: "omp-linux-x64", digest: `sha256:${X64.toUpperCase()}` }, RELEASE.assets[0]] }),
		/omp-linux-x64 has no valid SHA-256 digest/,
	);
});

test("updateContainerfile replaces exactly one complete OMP pin set", () => {
	const updated = updateContainerfile(OLD_CONTAINERFILE, { version: "18.2.1", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(updated, new RegExp(`^ARG OMP_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_AARCH64_SHA256=${ARM64}$`, "m"));
	assert.throws(() => updateContainerfile(`${OLD_CONTAINERFILE}ARG OMP_VERSION=1.0.0\n`, releasePins(RELEASE)), /expected one ARG OMP_VERSION pin/);
});

test("syncOmpPins updates contributor image from the Renovate-selected release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/contribute"), { recursive: true });
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
	const contribute = await readFile(join(root, "image/contribute/Containerfile"), "utf8");
	assert.match(contribute, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(contribute, new RegExp(`^ARG OMP_X86_64_SHA256=${X64}$`, "m"));
	assert.match(contribute, new RegExp(`^ARG OMP_AARCH64_SHA256=${ARM64}$`, "m"));
});

async function ompRoot(t, containerfile = OLD_CONTAINERFILE) {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/contribute/Containerfile"), containerfile);
	return root;
}

function withTokens(t, values) {
	const saved = Object.fromEntries(TOKEN_VARIABLES.map((name) => [name, process.env[name]]));
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	setTokens(values);
}

function setTokens(values) {
	for (const name of TOKEN_VARIABLES) {
		if (values[name] === undefined) delete process.env[name];
		else process.env[name] = values[name];
	}
}

test("syncOmpPins strips a leading v and asks GitHub for exactly that tag without following redirects", async (t) => {
	withTokens(t, {});
	const root = await ompRoot(t);
	const requests = [];
	const pins = await syncOmpPins({
		root,
		requestedVersion: "v18.2.1",
		fetchImpl: async (url, init) => {
			requests.push({ url: String(url), init });
			return response(RELEASE);
		},
	});

	assert.equal(pins.version, "18.2.1");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.2.1");
	assert.equal(requests[0].init.redirect, "error");
	assert.equal(requests[0].init.headers.Accept, "application/vnd.github+json");
	assert.equal(requests[0].init.headers["User-Agent"], "hive-contribute-omp-sync");
	assert.equal(requests[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
	assert.equal("Authorization" in requests[0].init.headers, false, "no token, no Authorization header");
	assert.match(await readFile(join(root, "image/contribute/Containerfile"), "utf8"), /^ARG OMP_VERSION=18\.2\.1$/m);
});

test("syncOmpPins authenticates with the first token set, Renovate's before gh's before Actions'", async (t) => {
	const cases = [
		[{ RENOVATE_TOKEN: "renovate", GH_TOKEN: "gh", GITHUB_TOKEN: "actions" }, "renovate"],
		[{ GH_TOKEN: "gh", GITHUB_TOKEN: "actions" }, "gh"],
		[{ GITHUB_TOKEN: "actions" }, "actions"],
	];
	withTokens(t, {});
	for (const [tokens, expected] of cases) {
		setTokens(tokens);
		const root = await ompRoot(t, RENOVATED_CONTAINERFILE);
		let authorization;
		await syncOmpPins({
			root,
			fetchImpl: async (_url, init) => {
				authorization = init.headers.Authorization;
				return response(RELEASE);
			},
		});
		assert.equal(authorization, `Bearer ${expected}`);
	}
});

test("syncOmpPins leaves the Containerfile untouched when the release cannot be trusted", async (t) => {
	withTokens(t, {});
	const refusals = [
		["a failed lookup", { ok: false, status: 404, statusText: "Not Found", json: async () => RELEASE }, /GitHub release lookup failed: 404 Not Found/],
		["a different release", response({ ...RELEASE, tag_name: "v18.2.0" }), /requested OMP 18\.2\.1, received 18\.2\.0/],
		["a prerelease", response({ ...RELEASE, prerelease: true }), /published stable release/],
		["a missing asset", response({ ...RELEASE, assets: [RELEASE.assets[0]] }), /no omp-linux-x64 asset/],
	];
	for (const [name, reply, error] of refusals) {
		const root = await ompRoot(t);
		await assert.rejects(syncOmpPins({ root, requestedVersion: "18.2.1", fetchImpl: async () => reply }), error, name);
		assert.equal(await readFile(join(root, "image/contribute/Containerfile"), "utf8"), OLD_CONTAINERFILE, name);
	}
});

test("syncOmpPins refuses an invalid version before contacting GitHub", async (t) => {
	let fetched = false;
	const fetchImpl = async () => {
		fetched = true;
		return response(RELEASE);
	};
	for (const requestedVersion of ["18.2", "latest", "18.2.1-rc1", "18.2.1; rm -rf /"]) {
		const root = await ompRoot(t);
		await assert.rejects(syncOmpPins({ root, requestedVersion, fetchImpl }), /invalid requested OMP version/);
	}
	const root = await ompRoot(t, OLD_CONTAINERFILE.replace("18.1.22", "next"));
	await assert.rejects(syncOmpPins({ root, fetchImpl }), /invalid OMP version next/);
	assert.equal(fetched, false);
});

test("syncPins refuses to pick a version when the tracked Containerfiles disagree", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "release-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "A.Containerfile"), OLD_CONTAINERFILE);
	await writeFile(join(root, "B.Containerfile"), RENOVATED_CONTAINERFILE);
	const pins = createContainerfilePins({
		label: "OMP",
		argPrefix: "OMP",
		versionPattern: /^\d+\.\d+\.\d+$/,
		containerfiles: ["A.Containerfile", "B.Containerfile"],
	});
	let resolved = 0;
	const resolvePins = async (version) => {
		resolved += 1;
		return { version, x86_64: X64, aarch64: ARM64 };
	};

	await assert.rejects(pins.syncPins(resolvePins, { root }), /OMP versions differ across shipped images: 18\.1\.22, 18\.2\.1/);
	assert.equal(resolved, 0);
	assert.equal(await readFile(join(root, "A.Containerfile"), "utf8"), OLD_CONTAINERFILE);

	// An explicit version is the operator's decision and realigns every file.
	await pins.syncPins(resolvePins, { root, requestedVersion: "18.2.1" });
	assert.equal(resolved, 1);
	for (const name of ["A.Containerfile", "B.Containerfile"]) {
		const source = await readFile(join(root, name), "utf8");
		assert.match(source, /^ARG OMP_VERSION=18\.2\.1$/m, name);
		assert.match(source, new RegExp(`^ARG OMP_X86_64_SHA256=${X64}$`, "m"), name);
	}
});

test("update-omp-pins.mjs run as a script reports a refusal as one line and exit 1", async (t) => {
	const root = await ompRoot(t);
	const result = spawnSync(process.execPath, [OMP_SCRIPT, "not-a-version"], {
		cwd: root,
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "invalid requested OMP version: not-a-version\n");
	assert.equal(await readFile(join(root, "image/contribute/Containerfile"), "utf8"), OLD_CONTAINERFILE);
});

test("Renovate follows OMP releases and contributor image publisher validates the pin sync", async () => {
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
	assert.equal(rule.automergeStrategy, "squash");
	assert.deepEqual(rule.postUpgradeTasks.commands, ["node scripts/update-omp-pins.mjs"]);
	assert.deepEqual(rule.postUpgradeTasks.fileFilters, ["image/contribute/Containerfile"]);

	const renovateWorkflow = await readFile(".github/workflows/renovate.yml", "utf8");
	assert.match(renovateWorkflow, /cron: '15 2 \* \* \*'/);
	assert.match(renovateWorkflow, /RENOVATE_ALLOWED_COMMANDS:.*update-omp-pins/);
	assert.match(renovateWorkflow, /RENOVATE_REPOSITORIES: \$\{\{ github\.repository \}\}/);
	const workflow = await readFile(".github/workflows/publish-contribute.yml", "utf8");
	assert.match(workflow, /push:\n    branches:\n      - main/);
	assert.match(workflow, /node --test tests\/update-omp-pins\.test\.mjs/);
});
