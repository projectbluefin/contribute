export interface CiJobFailure {
	jobId: number;
	jobName: string;
	failedStep: string;
	logExcerpt: string;
	htmlUrl: string;
}

export interface CiRunItem {
	repo: string;
	workflowName: string;
	runId: number;
	runAttempt: number;
	headSha: string;
	branch: string;
	prNumber?: number;
	prUrl?: string;
	isBaseImage?: boolean;
	failures: CiJobFailure[];
}

export interface CiRepoBatch {
	repo: string;
	priority: number;
	items: CiRunItem[];
}

/**
 * Classifies whether a repo or workflow represents a base image or prerequisite build dependency.
 */
export function classifyBaseImageDependency(repo: string, workflowName: string): boolean {
	const normalizedRepo = repo.toLowerCase();
	const normalizedWorkflow = workflowName.toLowerCase();

	const baseRepoPatterns = [
		/base-image/,
		/base-images/,
		/(^|\/)common($|\/)/,
		/bluefin-common/,
		/framework-base/,
		/core-image/,
	];

	const baseWorkflowPatterns = [
		/build-base/,
		/publish-base/,
		/base-image/,
		/core-build/,
	];

	if (baseRepoPatterns.some((pattern) => pattern.test(normalizedRepo))) {
		return true;
	}

	if (baseWorkflowPatterns.some((pattern) => pattern.test(normalizedWorkflow))) {
		return true;
	}

	return false;
}

/**
 * Groups CI run items by repository and prioritizes them:
 * - Repositories containing base image builds come first (priority 1).
 * - Other repositories follow with dependent priorities (priority 2).
 * - Within each repository batch, runs with base image flags or prerequisite failures are sorted first.
 */
export function batchCiRunsByRepo(runs: CiRunItem[]): CiRepoBatch[] {
	const repoMap = new Map<string, CiRunItem[]>();

	for (const run of runs) {
		const isBase = run.isBaseImage ?? classifyBaseImageDependency(run.repo, run.workflowName);
		const runItem: CiRunItem = {
			...run,
			isBaseImage: isBase,
		};

		const existing = repoMap.get(runItem.repo);
		if (existing) {
			existing.push(runItem);
		} else {
			repoMap.set(runItem.repo, [runItem]);
		}
	}

	const batches: CiRepoBatch[] = [];

	for (const [repo, items] of repoMap.entries()) {
		const hasBaseImageRun = items.some((item) => item.isBaseImage);
		const priority = hasBaseImageRun ? 1 : 2;

		// Sort items within repo: base image builds first, then by runId descending
		const sortedItems = [...items].sort((a, b) => {
			const aBase = a.isBaseImage ? 1 : 0;
			const bBase = b.isBaseImage ? 1 : 0;
			if (aBase !== bBase) {
				return bBase - aBase;
			}
			return b.runId - a.runId;
		});

		batches.push({
			repo,
			priority,
			items: sortedItems,
		});
	}

	// Sort batches by priority ascending (1 before 2), then repo name alphabetically
	batches.sort((a, b) => {
		if (a.priority !== b.priority) {
			return a.priority - b.priority;
		}
		return a.repo.localeCompare(b.repo);
	});

	return batches;
}

/**
 * Generates a focused task prompt for the `ci-maintainer` subagent with failing workflow,
 * job, step, and log excerpt.
 */
export function formatCiRepairPrompt(item: CiRunItem): string {
	const prInfo = item.prNumber
		? `PR: #${item.prNumber}${item.prUrl ? ` (${item.prUrl})` : ""}`
		: "Branch build (no PR)";

	const failureDetails = item.failures.length > 0
		? item.failures.map((f, idx) => {
			return [
				`### Failure ${idx + 1}: Job "${f.jobName}" (ID: ${f.jobId})`,
				`- Failed Step: ${f.failedStep}`,
				`- Job URL: ${f.htmlUrl}`,
				"- Log Excerpt:",
				"```",
				f.logExcerpt.trim(),
				"```",
			].join("\n");
		}).join("\n\n")
		: "No detailed step failures recorded.";

	return [
		`# CI Repair Request: ${item.repo} - ${item.workflowName}`,
		"",
		`Repository: ${item.repo}`,
		`Workflow: ${item.workflowName} (Run ID: ${item.runId}, Attempt: ${item.runAttempt})`,
		`Branch: ${item.branch} (Head SHA: ${item.headSha})`,
		prInfo,
		`Base Image Prerequisite: ${item.isBaseImage ? "Yes" : "No"}`,
		"",
		"## Failure Details",
		failureDetails,
		"",
		"## Instructions",
		"- Analyze the failure logs above.",
		"- Identify the root cause in the workflow definition or build scripts.",
		"- Propose or apply minimal, safe fixes to restore the build pipeline.",
	].join("\n");
}
