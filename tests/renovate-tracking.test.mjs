// Renovate's pin tracking, asserted against the files it actually tracks.
//
// WHY THIS EXISTS. The OMP pin sat five releases behind while every visible
// signal said the tracking was healthy: the custom manager matched, Renovate
// resolved each new release, and it pushed every one of them onto
// `renovate/omp-runtime`. What never happened was a pull request — branch
// creation is not rate-limited, PR creation is, and under the stock
// `config:recommended` hourly limit that branch queued behind a daily stream
// of digest updates and never reached the front. Nothing failed, so nothing
// told anyone.
//
// These are the two ways that pipeline dies quietly, so both are checked here
// rather than discovered months later in a stale image:
//   1. The manager stops matching — an ARG renamed, a `# renovate:` comment
//      reworded, a file moved — and the dependency silently leaves Renovate's
//      view entirely.
//   2. The update is found but never delivered, because the rule that exempts
//      the image's runtime pins from the PR queue was dropped.
//
// Hermetic: reads the repository's own files, talks to nothing.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relativePath) => readFile(join(root, relativePath), "utf8");
const config = JSON.parse(await readRepoFile("renovate.json"));
const workflow = await readRepoFile(".github/workflows/renovate.yml");

// Renovate writes these as `/pattern/` strings; unwrap to a real RegExp so the
// test matches paths the same way Renovate does.
function unwrapPattern(pattern) {
	const match = /^\/(.*)\/$/s.exec(pattern);
	assert.ok(match, `managerFilePatterns entry is not /-delimited: ${pattern}`);
	return new RegExp(match[1]);
}

// The dependency each custom manager tracks, and the file it must find it in.
// Named here rather than derived from the config so a manager that silently
// stops covering one of them is a failure instead of an empty loop.
const TRACKED = [
	{ depName: "can1357/oh-my-pi", file: "image/contribute/Containerfile", arg: "OMP_VERSION" },
	{ depName: "cli/cli", file: "image/contribute/Containerfile", arg: "GH_VERSION" },
	{ depName: "node", file: "image/contribute/Containerfile", arg: "NODE_VERSION" },
	{ depName: "tmux/tmux-builds", file: "image/contribute/Containerfile", arg: "TMUX_VERSION" },
];

const customManagerFor = (depName) =>
	config.customManagers.find((manager) => manager.depNameTemplate === depName);

test("every tracked runtime pin has a custom manager that matches its file", async () => {
	for (const { depName, file } of TRACKED) {
		const manager = customManagerFor(depName);
		assert.ok(manager, `no custom manager tracks ${depName}`);
		const matched = manager.managerFilePatterns.some((pattern) => unwrapPattern(pattern).test(file));
		assert.ok(matched, `${depName}: no managerFilePatterns entry matches ${file}`);
	}
});

test("every matchStrings regex extracts exactly one currentValue from the tracked file", async () => {
	for (const { depName, file, arg } of TRACKED) {
		const manager = customManagerFor(depName);
		const source = await readRepoFile(file);
		for (const matchString of manager.matchStrings) {
			const matches = [...source.matchAll(new RegExp(matchString, "g"))];
			assert.equal(
				matches.length,
				1,
				`${depName}: matchStrings found ${matches.length} matches in ${file}; Renovate tracks nothing when this is 0`,
			);
			const currentValue = matches[0].groups?.currentValue;
			assert.ok(currentValue, `${depName}: matchStrings captured no currentValue`);
			// The captured value must be the pin the build actually consumes,
			// or Renovate would be bumping a line the image does not read.
			const pinned = new RegExp(`^ARG ${arg}=(.*)$`, "m").exec(source);
			assert.ok(pinned, `${file}: no ARG ${arg} pin`);
			assert.equal(currentValue, pinned[1], `${depName}: tracked value and ARG ${arg} disagree`);
		}
	}
});

test("runtime pins are exempt from the PR queue that starved them", async () => {
	for (const { depName } of TRACKED) {
		const exemption = config.packageRules.find(
			(rule) =>
				(rule.matchDepNames ?? []).includes(depName) &&
				rule.prConcurrentLimit === 0 &&
				rule.prHourlyLimit === 0,
		);
		assert.ok(
			exemption,
			`${depName}: no packageRule sets prConcurrentLimit/prHourlyLimit to 0. Renovate will create the branch and queue the PR behind unrelated digest updates, which is how the shipped OMP fell five releases behind.`,
		);
	}
});

test("both Renovate identities ignore each other's git author", async () => {
	// Two GitHub App installations evaluate this one renovate.json: the
	// `mergeraptor` token the workflow authenticates with, and a separately
	// installed `bluefin-ghost-arc` app that files the Dependency Dashboard.
	// Each installation's platform commits carry its own git author, and
	// with platform commits active Renovate ignores `gitAuthor` entirely, so
	// a branch pushed by one installation reads as a manual edit to the
	// other. That is how `renovate/omp-runtime` and
	// `renovate/hivecommons-hive-digest` got marked "PR has been edited" and
	// silently stopped receiving updates. See #638.
	const ignored = config.gitIgnoredAuthors ?? [];
	for (const email of [
		"267480593+mergeraptor[bot]@users.noreply.github.com",
		"295290144+bluefin-ghost-arc[bot]@users.noreply.github.com",
	]) {
		assert.ok(
			ignored.includes(email),
			`gitIgnoredAuthors is missing ${email}: Renovate will treat that identity's commits as a manual edit and stop repairing the branch.`,
		);
	}
	assert.ok(
		config.extends?.includes("local>projectbluefin/renovate-config"),
		"renovate.json no longer extends local>projectbluefin/renovate-config: config:recommended and the org preset would silently drop out.",
	);
});

test("every postUpgradeTask command is allowlisted in the Renovate workflow", async () => {
	const commands = config.packageRules.flatMap((rule) => rule.postUpgradeTasks?.commands ?? []);
	assert.ok(commands.length > 0, "no postUpgradeTasks commands are configured");
	const allowed = /RENOVATE_ALLOWED_COMMANDS:\s*'(?<json>\[[^\n]*\])'/.exec(workflow);
	assert.ok(allowed, ".github/workflows/renovate.yml does not set RENOVATE_ALLOWED_COMMANDS");
	const patterns = JSON.parse(allowed.groups.json).map((entry) => new RegExp(entry));
	for (const command of commands) {
		assert.ok(
			patterns.some((pattern) => pattern.test(command)),
			`postUpgradeTask "${command}" is not allowlisted, so Renovate would bump the version and leave the digests stale`,
		);
	}
});

test("the digest refresher for each pin is a real, executable script", async () => {
	const commands = config.packageRules.flatMap((rule) => rule.postUpgradeTasks?.commands ?? []);
	for (const command of commands) {
		const script = /^node (\S+\.mjs)$|^(\S+\.mjs)$/.exec(command);
		assert.ok(script, `postUpgradeTask "${command}" is not a node script invocation`);
		const path = script[1] ?? script[2];
		await assert.doesNotReject(readRepoFile(path), `${path} does not exist`);
	}
});

test("post-upgrade pin synchronizers are handed a GitHub token", async () => {
	// Renovate does not pass the workflow job's environment to a post-upgrade
	// command; it builds one from its own allowlist unless `exposeAllEnv` is
	// set. Every synchronizer reads a GitHub release, so without an explicit
	// hand-off they call api.github.com anonymously — 60 requests an hour from
	// the runner's shared address — and a rate-limited lookup leaves the
	// version bumped beside the previous release's digests. The build then
	// fails at `sha256sum -c` — it never ships the wrong binary — but delivery
	// stops with a pull request that looks correct, which is the shape of
	// failure that went unnoticed for a week.
	const custom = /RENOVATE_CUSTOM_ENV_VARIABLES:\s*'(?<json>\{[^\n]*\})'/.exec(workflow);
	assert.ok(custom, "the Renovate workflow passes no customEnvVariables to post-upgrade commands");
	const names = Object.keys(JSON.parse(custom.groups.json.replaceAll(/\$\{\{[^}]*\}\}/g, "token")));
	assert.ok(
		names.some((name) => /^(GH_TOKEN|GITHUB_TOKEN|RENOVATE_TOKEN)$/.test(name)),
		`customEnvVariables hands over ${names.join(", ")}, none of which the synchronizers read`,
	);
	for (const script of ["scripts/update-omp-pins.mjs", "scripts/update-gh-pins.mjs", "scripts/update-tmux-pins.mjs"]) {
		const source = await readRepoFile(script);
		assert.match(source, /process\.env\.(RENOVATE_TOKEN|GH_TOKEN|GITHUB_TOKEN)/, `${script} reads no token`);
	}
});
