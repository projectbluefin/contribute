/** Confirmed GitHub comment plans and fail-closed live revalidation. */

export interface CommentTargetSnapshot {
	readonly repo: string;
	readonly number: number;
	readonly type: "pull_request" | "issue";
	readonly headSha?: string;
}

export interface NativeInvocation {
	readonly command: string;
	readonly args: readonly string[];
}

export interface CommentActionPlan {
	readonly id: string;
	readonly targets: readonly CommentTargetSnapshot[];
	readonly body: string;
	readonly signature: string;
	readonly createdAt: number;
}

export interface CommentPlanValidation {
	readonly valid: boolean;
	readonly errors: readonly string[];
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function commentInvocation(target: CommentTargetSnapshot, body: string): NativeInvocation {
	const subcommand = target.type === "pull_request" ? "pr" : "issue";
	return {
		command: "gh",
		args: [subcommand, "comment", String(target.number), "--repo", target.repo, "--body", body],
	};
}

export function createCommentActionPlan(
	targets: readonly CommentTargetSnapshot[],
	body: string,
	createdAt = Date.now(),
): CommentActionPlan {
	const trimmedBody = body.trim();
	if (!trimmedBody) {
		throw new Error("Comment body cannot be empty");
	}
	if (!targets || targets.length === 0) {
		throw new Error("Comment targets cannot be empty");
	}

	const seen = new Set<string>();
	for (const target of targets) {
		if (!target.repo || !REPO_PATTERN.test(target.repo)) {
			throw new Error(`Invalid target repository: ${target.repo}`);
		}
		if (!Number.isInteger(target.number) || target.number <= 0) {
			throw new Error(`Invalid target number: ${target.number}`);
		}
		if (target.type !== "pull_request" && target.type !== "issue") {
			throw new Error(`Invalid target type: ${(target as CommentTargetSnapshot).type}`);
		}
		if (target.type === "pull_request" && !target.headSha?.trim()) {
			throw new Error(`Missing pull request head for ${target.repo}#${target.number}`);
		}
		const key = `${target.repo}#${target.number}`;
		if (seen.has(key)) {
			throw new Error(`Duplicate comment target: ${key}`);
		}
		seen.add(key);
	}

	const targetSignatures = targets.map(
		(target) => `${target.type}:${target.repo}#${target.number}${target.headSha ? `@${target.headSha}` : ""}`,
	);
	const signature = `comment:${targetSignatures.join(",")}:${body}`;
	const id = `plan_${createdAt.toString(36)}_${Math.abs(
		signature.split("").reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0),
	).toString(36)}`;

	return Object.freeze({
		id,
		targets: Object.freeze(targets.map((t) => Object.freeze({ ...t }))),
		body,
		signature,
		createdAt,
	});
}

export function renderCommentActionPlan(plan: CommentActionPlan): string {
	const lines: string[] = [
		`Comment Action Plan (${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}):`,
	];
	for (const target of plan.targets) {
		const invocation = commentInvocation(target, plan.body);
		const headNote = target.headSha ? ` (head: ${target.headSha.slice(0, 7)})` : "";
		lines.push(`  - [${target.type}] ${target.repo}#${target.number}${headNote}`);
		lines.push(`    $ ${[invocation.command, ...invocation.args].join(" ")}`);
	}
	lines.push("Body:");
	const indentedBody = plan.body
		.split("\n")
		.map((l) => `    ${l}`)
		.join("\n");
	lines.push(indentedBody);
	return lines.join("\n");
}

export function validateCommentActionPlan(
	plan: CommentActionPlan,
	liveTargets: readonly CommentTargetSnapshot[],
): CommentPlanValidation {
	const errors: string[] = [];
	const liveMap = new Map<string, CommentTargetSnapshot>();
	for (const live of liveTargets) {
		liveMap.set(`${live.repo}#${live.number}`, live);
	}

	for (const target of plan.targets) {
		const key = `${target.repo}#${target.number}`;
		const live = liveMap.get(key);
		if (!live) {
			errors.push(`Target missing from live targets: ${key}`);
			continue;
		}
		if (live.type !== target.type) {
			errors.push(
				`Type mismatch for ${key}: plan expected ${target.type}, live target is ${live.type}`,
			);
		}
		if (target.type === "pull_request") {
			if (!target.headSha?.trim()) {
				errors.push(`No plan head for ${key}; cannot revalidate pull request`);
			}
			if (!live.headSha) {
				errors.push(`No live head for ${key}; cannot revalidate plan snapshot ${target.headSha}`);
			} else if (target.headSha !== live.headSha) {
				errors.push(`PR head changed for ${key}: plan snapshot was ${target.headSha}, live is ${live.headSha}`);
			}
		}
	}

	return Object.freeze({
		valid: errors.length === 0,
		errors: Object.freeze(errors),
	});
}
