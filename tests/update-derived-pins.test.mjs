import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	releasePins as ghReleasePins,
	syncGhPins,
	updateContainerfile as updateGhContainerfile,
} from "../scripts/update-gh-pins.mjs";

import {
	parseShasums as parseNodeShasums,
	syncNodePins,
	updateContainerfile as updateNodeContainerfile,
} from "../scripts/update-node-pins.mjs";

import {
	releasePins as tmuxReleasePins,
	syncTmuxPins,
	updateContainerfile as updateTmuxContainerfile,
} from "../scripts/update-tmux-pins.mjs";

import {
	fetchPackageHashes,
	syncRequirementsCiHashes,
	updateLockfileContent,
} from "../scripts/update-requirements-ci-hashes.mjs";

const X64 = "a".repeat(64);
const ARM64 = "b".repeat(64);

function response(payload, { status = 200, statusText = "OK" } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		json: async () => payload,
		text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
	};
}

// --------------------------------------------------------------------------
// GH (cli/cli) contracts
// --------------------------------------------------------------------------

const GH_RELEASE = {
	tag_name: "v2.97.0",
	draft: false,
	prerelease: false,
	assets: [
		{ name: "gh_2.97.0_linux_amd64.tar.gz", digest: `sha256:${X64}` },
		{ name: "gh_2.97.0_linux_arm64.tar.gz", digest: `sha256:${ARM64}` },
	],
};

const OLD_GH_CONTAINERFILE = `# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.96.0
ARG GH_X86_64_SHA256=${"1".repeat(64)}
ARG GH_AARCH64_SHA256=${"2".repeat(64)}
`;
const RENOVATED_GH_CONTAINERFILE = OLD_GH_CONTAINERFILE.replace("2.96.0", "2.97.0");

test("ghReleasePins accepts only stable GH assets with SHA-256 digests", () => {
	assert.deepEqual(ghReleasePins(GH_RELEASE), { version: "2.97.0", x86_64: X64, aarch64: ARM64 });
	assert.throws(() => ghReleasePins({ ...GH_RELEASE, prerelease: true }), /published stable release/);
	assert.throws(() => ghReleasePins({ ...GH_RELEASE, draft: true }), /published stable release/);
	assert.throws(
		() => ghReleasePins({ ...GH_RELEASE, assets: GH_RELEASE.assets.filter((a) => !a.name.includes("arm64")) }),
		/has no gh_2\.97\.0_linux_arm64\.tar\.gz asset/,
	);
	assert.throws(
		() => ghReleasePins({
			...GH_RELEASE,
			assets: [
				{ name: "gh_2.97.0_linux_amd64.tar.gz", digest: "" },
				GH_RELEASE.assets[1],
			],
		}),
		/no valid SHA-256 digest/,
	);
});

test("updateGhContainerfile replaces exactly one complete GH pin set", () => {
	const updated = updateGhContainerfile(OLD_GH_CONTAINERFILE, { version: "2.97.0", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG GH_VERSION=2\.97\.0$/m);
	assert.match(updated, new RegExp(`^ARG GH_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG GH_AARCH64_SHA256=${ARM64}$`, "m"));
	assert.throws(
		() => updateGhContainerfile(`${OLD_GH_CONTAINERFILE}ARG GH_VERSION=2.0.0\n`, { version: "2.97.0", x86_64: X64, aarch64: ARM64 }),
		/expected one ARG GH_VERSION pin/,
	);
});
test("syncGhPins updates contributor image atomically", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "gh-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/contribute/Containerfile"), RENOVATED_GH_CONTAINERFILE);

	const urls = [];
	const pins = await syncGhPins({
		root,
		fetchImpl: async (url) => {
			urls.push(String(url));
			return response(GH_RELEASE);
		},
	});

	assert.equal(pins.version, "2.97.0");
	assert.deepEqual(urls, ["https://api.github.com/repos/cli/cli/releases/tags/v2.97.0"]);
	const contribute = await readFile(join(root, "image/contribute/Containerfile"), "utf8");
	assert.match(contribute, /^ARG GH_VERSION=2\.97\.0$/m);
	assert.match(contribute, new RegExp(`^ARG GH_X86_64_SHA256=${X64}$`, "m"));
	assert.match(contribute, new RegExp(`^ARG GH_AARCH64_SHA256=${ARM64}$`, "m"));
});

// --------------------------------------------------------------------------
// Node (node-version) contracts
// --------------------------------------------------------------------------

const NODE_SHASUMS = `${X64}  node-v24.18.1-linux-x64.tar.xz
${ARM64}  node-v24.18.1-linux-arm64.tar.xz
${"c".repeat(64)}  node-v24.18.1-darwin-arm64.tar.gz
`;

const OLD_NODE_CONTAINERFILE = `# renovate: datasource=node-version depName=node
ARG NODE_VERSION=24.18.0
ARG NODE_X86_64_SHA256=${"1".repeat(64)}
ARG NODE_AARCH64_SHA256=${"2".repeat(64)}
`;
const RENOVATED_NODE_CONTAINERFILE = OLD_NODE_CONTAINERFILE.replace("24.18.0", "24.18.1");

test("parseNodeShasums extracts x64 and arm64 digests from SHASUMS256.txt", () => {
	const pins = parseNodeShasums(NODE_SHASUMS, "24.18.1");
	assert.deepEqual(pins, { version: "24.18.1", x86_64: X64, aarch64: ARM64 });

	assert.throws(
		() => parseNodeShasums(`${X64}  node-v24.18.1-linux-x64.tar.xz\n`, "24.18.1"),
		/missing required node-v24\.18\.1-linux-arm64\.tar\.xz SHA-256/,
	);
	assert.throws(
		() => parseNodeShasums("not-a-valid-sha  node-v24.18.1-linux-x64.tar.xz\n", "24.18.1"),
		/missing required node-v24\.18\.1-linux-x64\.tar\.xz SHA-256/,
	);
});

test("updateNodeContainerfile replaces exactly one complete Node pin set", () => {
	const updated = updateNodeContainerfile(OLD_NODE_CONTAINERFILE, { version: "24.18.1", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG NODE_VERSION=24\.18\.1$/m);
	assert.match(updated, new RegExp(`^ARG NODE_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG NODE_AARCH64_SHA256=${ARM64}$`, "m"));
});

test("syncNodePins updates contributor image from SHASUMS256.txt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "node-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/contribute/Containerfile"), RENOVATED_NODE_CONTAINERFILE);

	const urls = [];
	const pins = await syncNodePins({
		root,
		fetchImpl: async (url) => {
			urls.push(String(url));
			return response(NODE_SHASUMS);
		},
	});

	assert.equal(pins.version, "24.18.1");
	assert.deepEqual(urls, ["https://nodejs.org/dist/v24.18.1/SHASUMS256.txt"]);
	const contribute = await readFile(join(root, "image/contribute/Containerfile"), "utf8");
	assert.match(contribute, /^ARG NODE_VERSION=24\.18\.1$/m);
	assert.match(contribute, new RegExp(`^ARG NODE_X86_64_SHA256=${X64}$`, "m"));
	assert.match(contribute, new RegExp(`^ARG NODE_AARCH64_SHA256=${ARM64}$`, "m"));
});

// --------------------------------------------------------------------------
// tmux (tmux/tmux-builds) contracts
// --------------------------------------------------------------------------

const TMUX_RELEASE = {
	tag_name: "v3.7c",
	draft: false,
	prerelease: false,
	assets: [
		{ name: "tmux-3.7c-linux-x86_64.tar.gz", digest: `sha256:${X64}` },
		{ name: "tmux-3.7c-linux-arm64.tar.gz", digest: `sha256:${ARM64}` },
	],
};

const OLD_TMUX_CONTAINERFILE = `# renovate: datasource=github-releases depName=tmux/tmux-builds
ARG TMUX_VERSION=3.7b
ARG TMUX_X86_64_SHA256=${"1".repeat(64)}
ARG TMUX_AARCH64_SHA256=${"2".repeat(64)}
`;
const RENOVATED_TMUX_CONTAINERFILE = OLD_TMUX_CONTAINERFILE.replace("3.7b", "3.7c");

test("tmuxReleasePins accepts only stable tmux assets with SHA-256 digests", () => {
	assert.deepEqual(tmuxReleasePins(TMUX_RELEASE), { version: "3.7c", x86_64: X64, aarch64: ARM64 });
	assert.throws(() => tmuxReleasePins({ ...TMUX_RELEASE, prerelease: true }), /published stable release/);
	assert.throws(
		() => tmuxReleasePins({ ...TMUX_RELEASE, assets: [TMUX_RELEASE.assets[0]] }),
		/has no tmux-3\.7c-linux-arm64\.tar\.gz asset/,
	);
});

test("updateTmuxContainerfile replaces exactly one complete tmux pin set", () => {
	const updated = updateTmuxContainerfile(OLD_TMUX_CONTAINERFILE, { version: "3.7c", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG TMUX_VERSION=3\.7c$/m);
	assert.match(updated, new RegExp(`^ARG TMUX_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG TMUX_AARCH64_SHA256=${ARM64}$`, "m"));
});

test("syncTmuxPins updates contributor image from tmux-builds release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tmux-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/contribute"), { recursive: true });
	await writeFile(join(root, "image/contribute/Containerfile"), RENOVATED_TMUX_CONTAINERFILE);

	const urls = [];
	const pins = await syncTmuxPins({
		root,
		fetchImpl: async (url) => {
			urls.push(String(url));
			return response(TMUX_RELEASE);
		},
	});

	assert.equal(pins.version, "3.7c");
	assert.deepEqual(urls, ["https://api.github.com/repos/tmux/tmux-builds/releases/tags/v3.7c"]);
	const contribute = await readFile(join(root, "image/contribute/Containerfile"), "utf8");
	assert.match(contribute, /^ARG TMUX_VERSION=3\.7c$/m);
	assert.match(contribute, new RegExp(`^ARG TMUX_X86_64_SHA256=${X64}$`, "m"));
	assert.match(contribute, new RegExp(`^ARG TMUX_AARCH64_SHA256=${ARM64}$`, "m"));
});

// --------------------------------------------------------------------------
// PyPI (requirements-ci.lock) contracts
// --------------------------------------------------------------------------

test("fetchPackageHashes extracts and sorts unique sha256 digests from PyPI", async () => {
	const mockPyPiPayload = {
		urls: [
			{ digests: { sha256: X64 } },
			{ digests: { sha256: ARM64 } },
			{ digests: { sha256: X64 } },
		],
	};
	const hashes = await fetchPackageHashes("sample-pkg", "1.0.0", async () => response(mockPyPiPayload));
	assert.deepEqual(hashes, [X64, ARM64].sort());

	await assert.rejects(
		() => fetchPackageHashes("sample-pkg", "1.0.0", async () => response({}, { status: 404, statusText: "Not Found" })),
		/PyPI metadata lookup failed/,
	);
	await assert.rejects(
		() => fetchPackageHashes("sample-pkg", "1.0.0", async () => response({ urls: [] })),
		/No release files found on PyPI/,
	);
});

test("updateLockfileContent regenerates hashes and preserves comments", async () => {
	const initial = `# Header comment
# Compiled via: uv pip compile
foo==1.0.0 \\
    --hash=sha256:${"1".repeat(64)}
    # via bar
`;
	const updated = await updateLockfileContent(initial, async (url) => {
		assert.match(String(url), /pypi\.org\/pypi\/foo\/1\.0\.0\/json/);
		return response({
			urls: [
				{ digests: { sha256: X64 } },
				{ digests: { sha256: ARM64 } },
			],
		});
	});

	assert.match(updated, /^# Header comment/m);
	assert.match(updated, /^# Compiled via: uv pip compile/m);
	assert.match(updated, /^foo==1\.0\.0 \\$/m);
	assert.match(updated, new RegExp(`^    --hash=sha256:${[X64, ARM64].sort()[0]} \\\\$`, "m"));
	assert.match(updated, new RegExp(`^    --hash=sha256:${[X64, ARM64].sort()[1]}$`, "m"));
	assert.match(updated, /^    # via bar$/m);
});

test("updateLockfileContent keeps extras and environment markers, and refuses unparseable lines", async () => {
	const hashPayload = response({
		urls: [{ digests: { sha256: X64 } }, { digests: { sha256: ARM64 } }],
	});
	const lookups = [];
	const fetchImpl = async (url) => {
		lookups.push(String(url));
		return hashPayload;
	};

	// An extras requirement does not start with `name==`, so a splitter that
	// only recognises that shape folds it into the previous package's block and
	// drops the package, its hashes, and nothing else says so.
	const withExtras = `# Header
foo==1.0.0 \\
    --hash=sha256:${"1".repeat(64)}
    # via bar
coverage[toml]==7.6.0 \\
    --hash=sha256:${"2".repeat(64)}
    # via pytest-cov
`;
	const extrasUpdated = await updateLockfileContent(withExtras, fetchImpl);
	assert.match(extrasUpdated, /^coverage\[toml\]==7\.6\.0 \\$/m);
	assert.match(extrasUpdated, /^    # via pytest-cov$/m);
	// PyPI is queried for the project, not for the extras selector.
	assert.ok(lookups.some((url) => url.includes("/pypi/coverage/7.6.0/json")));

	// The marker decides whether the package installs at all, so re-emitting
	// the requirement without it silently changes what CI installs.
	const withMarker = `# Header
tomli==2.0.1 ; python_version < "3.11" \\
    --hash=sha256:${"3".repeat(64)}
    # via pytest
`;
	const markerUpdated = await updateLockfileContent(withMarker, fetchImpl);
	assert.match(markerUpdated, /^tomli==2\.0\.1 ; python_version < "3\.11" \\$/m);

	// Anything this cannot parse must stop the rewrite rather than be omitted
	// from it.
	await assert.rejects(
		() =>
			updateLockfileContent(
				`# Header\nfoo==1.0.0 unexpected-token \\\n    --hash=sha256:${"4".repeat(64)}\n`,
				fetchImpl,
			),
		/cannot parse requirement line/,
	);
});

// --------------------------------------------------------------------------
// Renovate configuration & workflow contracts
// --------------------------------------------------------------------------

test("Renovate configuration tracks GH, Node, tmux, and requirements-ci with postUpgradeTasks", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));

	// Check customManagers
	const ghManager = config.customManagers.find((m) => m.depNameTemplate === "cli/cli");
	assert.ok(ghManager, "GH needs a custom regex manager");
	assert.equal(ghManager.datasourceTemplate, "github-releases");
	assert.equal(ghManager.versioningTemplate, "semver-coerced");
	assert.match(ghManager.matchStrings[0], /ARG GH_VERSION/);

	const nodeManager = config.customManagers.find((m) => m.depNameTemplate === "node");
	assert.ok(nodeManager, "Node needs a custom regex manager");
	assert.equal(nodeManager.datasourceTemplate, "node-version");
	assert.equal(nodeManager.versioningTemplate, "node");
	assert.match(nodeManager.matchStrings[0], /ARG NODE_VERSION/);

	const tmuxManager = config.customManagers.find((m) => m.depNameTemplate === "tmux/tmux-builds");
	assert.ok(tmuxManager, "tmux needs a custom regex manager");
	assert.equal(tmuxManager.datasourceTemplate, "github-releases");
	assert.equal(tmuxManager.versioningTemplate, "loose");
	assert.match(tmuxManager.matchStrings[0], /ARG TMUX_VERSION/);

	const pypiManager = config.customManagers.find((m) => m.datasourceTemplate === "pypi");
	assert.ok(pypiManager, "PyPI requirements-ci.lock needs regex manager");

	// Check packageRules
	const ghRule = config.packageRules.find((r) => r.matchPackageNames?.includes("cli/cli"));
	assert.ok(ghRule, "GH needs a packageRule with postUpgradeTasks");
	assert.deepEqual(ghRule.postUpgradeTasks.commands, ["node scripts/update-gh-pins.mjs"]);
	assert.deepEqual(ghRule.postUpgradeTasks.fileFilters, [
		"image/contribute/Containerfile",
	]);
	const nodeRule = config.packageRules.find((r) => r.matchPackageNames?.includes("node"));
	assert.ok(nodeRule, "Node needs a packageRule with postUpgradeTasks");
	assert.deepEqual(nodeRule.postUpgradeTasks.commands, ["node scripts/update-node-pins.mjs"]);
	assert.deepEqual(nodeRule.postUpgradeTasks.fileFilters, ["image/contribute/Containerfile"]);

	const tmuxRule = config.packageRules.find((r) => r.matchPackageNames?.includes("tmux/tmux-builds"));
	assert.ok(tmuxRule, "tmux needs a packageRule with postUpgradeTasks");
	assert.deepEqual(tmuxRule.postUpgradeTasks.commands, ["node scripts/update-tmux-pins.mjs"]);
	assert.deepEqual(tmuxRule.postUpgradeTasks.fileFilters, ["image/contribute/Containerfile"]);

	const pypiRule = config.packageRules.find((r) => r.matchDatasources?.includes("pypi"));
	assert.ok(pypiRule, "PyPI needs a packageRule with postUpgradeTasks");
	assert.deepEqual(pypiRule.postUpgradeTasks.commands, ["node scripts/update-requirements-ci-hashes.mjs"]);
	assert.deepEqual(pypiRule.postUpgradeTasks.fileFilters, ["requirements-ci.lock"]);

	// Check Renovate workflow allows all update commands
	const renovateWorkflow = await readFile(".github/workflows/renovate.yml", "utf8");
	assert.match(renovateWorkflow, /update-omp-pins/);
	assert.match(renovateWorkflow, /update-gh-pins/);
	assert.match(renovateWorkflow, /update-node-pins/);
	assert.match(renovateWorkflow, /update-tmux-pins/);
	assert.match(renovateWorkflow, /update-requirements-ci-hashes/);

	const workflow = await readFile(".github/workflows/publish-contribute.yml", "utf8");
	assert.match(workflow, /push:\n    branches:\n      - main/);
	assert.match(workflow, /node --test tests\/update-derived-pins\.test\.mjs/);
});

// --------------------------------------------------------------------------
// Dependency extraction contract
// --------------------------------------------------------------------------

// This asserts that each manager still EXTRACTS the pin, never what the pin
// happens to be today. Asserting the current version here made every correct
// Renovate bump fail CI, and because these updates automerge only after checks
// pass, a red check is indistinguishable from a rejected update: the branch
// sits, the pin ages, and the test that was supposed to protect the pin is
// what stopped it from ever moving.
test("Renovate custom regex managers extract GH, Node, and tmux from Containerfile", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	const contribute = await readFile("image/contribute/Containerfile", "utf8");

	const pinnedArg = (arg) => {
		const match = new RegExp(`^ARG ${arg}=(.*)$`, "m").exec(contribute);
		assert.ok(match, `image/contribute/Containerfile has no ARG ${arg}`);
		return match[1];
	};
	const extracted = (depName) => {
		const manager = config.customManagers.find((m) => m.depNameTemplate === depName);
		assert.ok(manager, `no custom manager tracks ${depName}`);
		const match = new RegExp(manager.matchStrings[0], "m").exec(contribute);
		assert.ok(match, `${depName} extracted from image/contribute/Containerfile`);
		return match.groups.currentValue;
	};

	assert.equal(extracted("cli/cli"), pinnedArg("GH_VERSION"));
	assert.equal(extracted("node"), pinnedArg("NODE_VERSION"));
	assert.equal(extracted("tmux/tmux-builds"), pinnedArg("TMUX_VERSION"));

	const pypiManager = config.customManagers.find((m) => m.datasourceTemplate === "pypi");
	const pypiRegex = new RegExp(pypiManager.matchStrings[0], "gm");
	const lockfile = await readFile("requirements-ci.lock", "utf8");
	const pypiMatches = [...lockfile.matchAll(pypiRegex)];
	assert.ok(pypiMatches.length >= 10, "requirements-ci.lock packages extracted");
	const preCommit = pypiMatches.find((m) => m.groups.depName === "pre-commit");
	assert.ok(preCommit, "pre-commit extracted from requirements-ci.lock");
	assert.match(preCommit.groups.currentValue, /^\d+\.\d+(\.\d+)?$/);
});
