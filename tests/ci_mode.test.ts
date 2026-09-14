import assert from "node:assert/strict";
import test from "node:test";
import {
	batchCiRunsByRepo,
	classifyBaseImageDependency,
	formatCiRepairPrompt,
	type CiRunItem,
} from "../image/extension/bluefin-review/ci_mode.ts";

test("classifyBaseImageDependency: detects base image repos and workflows", () => {
	assert.equal(classifyBaseImageDependency("projectbluefin/base-images", "build.yml"), true);
	assert.equal(classifyBaseImageDependency("projectbluefin/common", "ci.yml"), true);
	assert.equal(classifyBaseImageDependency("projectbluefin/bluefin-common", "ci.yml"), true);
	assert.equal(classifyBaseImageDependency("projectbluefin/framework-base", "ci.yml"), true);
	assert.equal(classifyBaseImageDependency("projectbluefin/bluefin", "build-base.yml"), true);
	assert.equal(classifyBaseImageDependency("projectbluefin/bluefin", "publish-base-image.yml"), true);

	// Standard consumer repos/workflows
	assert.equal(classifyBaseImageDependency("projectbluefin/website", "deploy.yml"), false);
	assert.equal(classifyBaseImageDependency("projectbluefin/bluefin-docs", "lint.yml"), false);
	assert.equal(classifyBaseImageDependency("projectbluefin/bluefin", "build-iso.yml"), false);
});

test("batchCiRunsByRepo: groups runs and prioritizes base image prerequisite repos first", () => {
	const runs: CiRunItem[] = [
		{
			repo: "projectbluefin/website",
			workflowName: "deploy.yml",
			runId: 101,
			runAttempt: 1,
			headSha: "aaa111",
			branch: "main",
			failures: [
				{
					jobId: 1,
					jobName: "build",
					failedStep: "npm run build",
					logExcerpt: "Error: bundle failed",
					htmlUrl: "https://github.com/projectbluefin/website/actions/runs/101/job/1",
				},
			],
		},
		{
			repo: "projectbluefin/base-images",
			workflowName: "build-base.yml",
			runId: 202,
			runAttempt: 1,
			headSha: "bbb222",
			branch: "main",
			failures: [
				{
					jobId: 2,
					jobName: "container-build",
					failedStep: "podman build",
					logExcerpt: "Error: failed to fetch layer",
					htmlUrl: "https://github.com/projectbluefin/base-images/actions/runs/202/job/2",
				},
			],
		},
		{
			repo: "projectbluefin/bluefin",
			workflowName: "publish-base.yml",
			runId: 301,
			runAttempt: 2,
			headSha: "ccc333",
			branch: "main",
			isBaseImage: true,
			failures: [
				{
					jobId: 3,
					jobName: "cosign",
					failedStep: "cosign sign",
					logExcerpt: "signature failure",
					htmlUrl: "https://github.com/projectbluefin/bluefin/actions/runs/301/job/3",
				},
			],
		},
		{
			repo: "projectbluefin/bluefin",
			workflowName: "desktop-iso.yml",
			runId: 302,
			runAttempt: 1,
			headSha: "ccc333",
			branch: "main",
			isBaseImage: false,
			failures: [
				{
					jobId: 4,
					jobName: "iso-pack",
					failedStep: "mkisofs",
					logExcerpt: "command not found",
					htmlUrl: "https://github.com/projectbluefin/bluefin/actions/runs/302/job/4",
				},
			],
		},
	];

	const batches = batchCiRunsByRepo(runs);

	// Should produce 3 batches: base-images (priority 1), bluefin (priority 1 due to publish-base), website (priority 2)
	assert.equal(batches.length, 3);

	// Priority 1 batches come first, alphabetically sorted: bluefin, then base-images (or vice versa)
	assert.equal(batches[0].priority, 1);
	assert.equal(batches[1].priority, 1);
	assert.equal(batches[2].priority, 2);

	const repoNamesOrder = batches.map((b) => b.repo);
	assert.deepEqual(repoNamesOrder, [
		"projectbluefin/base-images",
		"projectbluefin/bluefin",
		"projectbluefin/website",
	]);

	// Within projectbluefin/bluefin, the base image run (301) should come before non-base (302)
	const bluefinBatch = batches.find((b) => b.repo === "projectbluefin/bluefin");
	assert.ok(bluefinBatch);
	assert.equal(bluefinBatch.items[0].runId, 301);
	assert.equal(bluefinBatch.items[0].isBaseImage, true);
	assert.equal(bluefinBatch.items[1].runId, 302);
	assert.equal(bluefinBatch.items[1].isBaseImage, false);
});

test("formatCiRepairPrompt: formats a clear prompt for ci-maintainer", () => {
	const run: CiRunItem = {
		repo: "projectbluefin/common",
		workflowName: "build-base.yml",
		runId: 405,
		runAttempt: 1,
		headSha: "deadbeef",
		branch: "fix-deps",
		prNumber: 99,
		prUrl: "https://github.com/projectbluefin/common/pull/99",
		isBaseImage: true,
		failures: [
			{
				jobId: 888,
				jobName: "lint-and-check",
				failedStep: "Check Containerfile",
				logExcerpt: "Line 42: unknown instruction FOO\nbuild exit 1",
				htmlUrl: "https://github.com/projectbluefin/common/actions/runs/405/job/888",
			},
		],
	};

	const prompt = formatCiRepairPrompt(run);

	assert.match(prompt, /CI Repair Request: projectbluefin\/common - build-base\.yml/);
	assert.match(prompt, /Workflow: build-base\.yml \(Run ID: 405, Attempt: 1\)/);
	assert.match(prompt, /Branch: fix-deps \(Head SHA: deadbeef\)/);
	assert.match(prompt, /PR: #99/);
	assert.match(prompt, /Base Image Prerequisite: Yes/);
	assert.match(prompt, /Job "lint-and-check" \(ID: 888\)/);
	assert.match(prompt, /Failed Step: Check Containerfile/);
	assert.match(prompt, /Line 42: unknown instruction FOO/);
});
