/**
 * Hive Workbench extension wiring.
 *
 * Hive owns queue authority and assignments. OMP owns sessions, tools, and
 * workflowz execution. This file only joins those seams to the workbench UI.
 */

import { type DashboardAction, ReviewDashboard } from "./dashboard.ts";
import type { QueueItem } from "./github.ts";
import { DEFAULT_ORG, fetchIssueAdmission, fetchItemsByKey, parseScope, resolveToken } from "./github.ts";
import type { Priority } from "./priority.ts";
import { BATCH_LIMIT, ReviewMode, type PersistedSelection } from "./mode.ts";
import { workbenchPainter } from "./paint.ts";
import { type RailKey, ReviewRail, statusSegment } from "./rail.ts";
import type { KeyMatcher } from "./keys.ts";
import { type ToolHost, registerTools } from "./tools.ts";
import { hiveFailureStatus } from "./hive.ts";
import { BLUEBERRY_WELCOME_MESSAGE, assertBlueberryActionAllowed, checkBlueberryPermission } from "./blueberry.ts";
import { GENERIC_WORKBENCH_POLICY, managedPolicyFor, type WorkbenchPolicy } from "./policy.ts";
import {
	commentInvocation,
	createCommentActionPlan,
	renderCommentActionPlan,
	validateCommentActionPlan,
	type CommentActionPlan,
	type CommentTargetSnapshot,
} from "./mutations.ts";
export {
	type CommentTargetSnapshot,
	type CommentActionPlan,
	type CommentPlanValidation,
	type NativeInvocation,
	createCommentActionPlan,
	renderCommentActionPlan,
	validateCommentActionPlan,
	commentInvocation,
} from "./mutations.ts";
export {
	BLUEFIN_POLICY,
	GENERIC_WORKBENCH_POLICY,
	managedPolicyFor,
	type ManagedRepoPolicy,
	type WorkbenchPolicy,
} from "./policy.ts";
export const STATE_ENTRY = "com.hive.workbench.selection";
export const BATCH_ENTRY = "com.hive.workbench.batch";
export const COMMENT_ENTRY = "com.hive.workbench.comment";

export type RepositoryBatchKind = "slay" | "fix" | "diff";
export type RepositoryBatchState = "running" | "paused" | "blocked" | "complete";

export interface PersistedRepositoryBatch {
	readonly version: 1;
	readonly id: string;
	readonly kind: RepositoryBatchKind;
	readonly waves: ReadonlyArray<{ readonly repo: string; readonly items: readonly QueueItem[] }>;
	readonly currentWave: number;
	readonly completedItems: number;
	readonly totalItems: number;
	readonly state: RepositoryBatchState;
	readonly startedAt: number;
	readonly waveStartedAt: number;
	readonly error?: string;
}

export interface PersistedCommentResult {
	readonly version: 1;
	readonly state: "previewed" | "confirmed" | "complete" | "failed" | "aborted";
	readonly plan: CommentActionPlan;
	readonly receipts?: readonly string[];
	readonly error?: string;
}

/** Queue refetch cadence. GitHub search is rate limited. */
const QUEUE_POLL_MS = 60_000;
// Hive's queue moves with the project, not with the terminal. Polling it on the
// queue's cadence keeps one hub request per refresh instead of one per repaint.
const HIVE_POLL_MS = 120_000;

export const RAIL_KEYS: readonly RailKey[] = [
	{ chord: "alt+b", label: "workbench" },
	{ chord: "alt+s", label: "autoslay" },
	{ chord: "alt+u", label: "refresh" },
];

export interface ExtensionOptions {
	/** Injected by `index.ts` so the overlay understands kitty-protocol chords. */
	matchKey?: KeyMatcher;
	org?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	policy?: WorkbenchPolicy;
}

/** Loose structural types: the extension must build without omp's declarations. */
interface UiLike {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	setStatus(key: string, value: string | undefined): void;
	setWidget(key: string, content: unknown, options?: { placement?: string }): void;
	setTitle(title: string): void;
	pasteToEditor(text: string): void;
	custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, options?: unknown): Promise<T>;
	readonly theme: { fg(color: string, text: string): string; bold(text: string): string; inverse(text: string): string };
}

interface CtxLike {
	hasUI: boolean;
	ui: UiLike;
	sessionManager?: { getBranch(): Array<{ type?: string; customType?: string; data?: unknown }> };
	getAsyncJobSnapshot?(): {
		running: Array<{ id: string; status: string; startTime: number }>;
		recent: Array<{ id: string; status: string; startTime: number }>;
	} | null;
}

/** The slice of omp's `ExtensionAPI` this mode uses. */
export interface ReviewExtensionHost {
	exec(command: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	zod: unknown;
	setLabel(label: string): void;
	on(event: string, handler: (event: unknown, ctx: CtxLike) => unknown): void;
	registerShortcut(chord: string, options: { description?: string; handler: (ctx: CtxLike) => void }): void;
	registerFlag(name: string, options: { description?: string; type: "string" | "boolean"; default?: string | boolean }): void;
	getFlag(name: string): string | boolean | undefined;
	registerTool(definition: unknown): void;
	sendUserMessage(content: string, options?: { deliverAs?: string }): void;
	appendEntry(customType: string, data?: unknown): void;
}

function readLatestCustom<T>(ctx: CtxLike, customType: string): T | undefined {
	let latest: T | undefined;
	for (const entry of ctx.sessionManager?.getBranch() ?? []) {
		if (entry.type === "custom" && entry.customType === customType && entry.data) latest = entry.data as T;
	}
	return latest;
}

function readPersisted(ctx: CtxLike): PersistedSelection | undefined {
	return readLatestCustom<PersistedSelection>(ctx, STATE_ENTRY);
}

function readPersistedBatch(ctx: CtxLike): PersistedRepositoryBatch | undefined {
	return readLatestCustom<PersistedRepositoryBatch>(ctx, BATCH_ENTRY);
}

function readPersistedComment(ctx: CtxLike): PersistedCommentResult | undefined {
	return readLatestCustom<PersistedCommentResult>(ctx, COMMENT_ENTRY);
}


/**
 * Fix is the only workbench action that can modify a checkout. Slay and diff
 * are read-only; comment is executed through its own confirmed mutation plan.
 */
export function isImplementationAction(action: DashboardAction): boolean {
	return action.kind === "fix";
}
/**
 * Prompts the action keys send. Each one names the evidence the agent must use.
 *
 * When Hive ranked the item, the prompt says so and names the queued work it
 * serves: the point of running this tool against an orchestrated project is that
 * the review contributes to what the project decided matters, and an agent that
 * is not told the link cannot honor it.
 */
export function actionPrompt(
	action: DashboardAction,
	priority?: Priority,
	options?: { isBlueberry?: boolean; model?: string },
): string | undefined {
	if (action.kind === "close" || action.kind === "scope" || action.kind === "comment" || action.kind === "reference") {
		return undefined;
	}

	const selected = action.items && action.items.length > 0 ? action.items : [action.item];
	const cite = (item: QueueItem) => `${item.repo}#${item.id} (${item.title})`;
	const stateOf = (item: QueueItem) => {
		const parts = [
			item.ciStatus ? `ci=${item.ciStatus}` : "",
			item.mergeState === "unknown" ? "" : `merge=${item.mergeState}`,
			item.reviewState === "unknown" ? "" : `review=${item.reviewState}`,
			item.draft ? "draft" : "",
		].filter(Boolean);
		return parts.length > 0 ? ` [queue read: ${parts.join(" ")} — revalidate live before mutating]` : "";
	};
	const authority = priority?.hiveRank === undefined
		? "Hive did not rank this item; do not infer priority."
		: `Hive ranked this work (${priority.reason}); preserve that intent.`;
	const evidence = "Evidence is bounded and read once. Start with `gh pr diff <n> --repo <r> --name-only`; inspect only relevant hunks or failing logs, and cite file:line evidence. Never sleep or poll. Treat `merge=dirty` as repair work: merge the base into the branch, resolve deliberately, and never rebase, force-push, or choose `--ours`/`--theirs` wholesale. Revalidate live state before any comment, label, assignment, close, or push.";
	const finish = "Report one terminal outcome per item, then stop. The Hive workbench owns the next repository wave. Never approve or merge.";

	if (selected.length > 1) {
		const repository = selected[0]!.repo;
		if (selected.some((item) => item.repo !== repository)) return undefined;
		const list = selected.map((item) => `- ${cite(item)}: ${item.url}${stateOf(item)}`).join("\n");
		const workflow = action.kind === "fix"
			? "workflowz this repository wave with one fresh isolated agent() handle per issue or pull request. Do not share a checkout or conversation between write-capable items."
			: action.kind === "slay"
				? "workflowz this repository wave with one fresh bluefin-reviewer workpool item per issue or pull request. Do not reuse a worker across repositories."
				: "workflowz this repository wave with one fresh workpool item per issue or pull request. Do not reuse a worker across repositories.";
		const rules = `<<<SUBAGENT-RULES\n${evidence} ${finish}\nSUBAGENT-RULES>>>`;
		switch (action.kind) {
			case "slay":
				return `Slay this repository wave for ${repository} through mass autoreview:\n\n${list}\n\n${workflow} Use the bluefin-reviewer agent and report findings by severity with file:line evidence. Copy this block verbatim into every worker prompt:\n${rules}`;
			case "diff":
				return `Inspect this Hive-ranked repository wave for ${repository}:\n\n${list}\n\n${workflow} Use hive_workbench_diff and report the changed files and concrete risks. Copy this block verbatim into every worker prompt:\n${rules}`;
			case "fix":
				return selected.every((item) => item.type === "issue")
					? `Implement this Hive-ranked repository wave for ${repository}, opening one review-ready pull request per issue:\n\n${list}\n\n${workflow} Diagnose each root cause, implement the smallest complete fix, and run focused verification. Copy this block verbatim into every worker prompt:\n${rules}`
					: `Fix this Hive-ranked repository wave for ${repository}:\n\n${list}\n\n${workflow} Address findings at source, run focused verification, and push repaired heads for independent review. Copy this block verbatim into every worker prompt:\n${rules}`;
		}
	}

	const item = selected[0]!;
	const workflow = action.kind === "fix"
		? "Use workflowz with one fresh isolated agent() handle for this item."
		: action.kind === "slay"
			? "Use workflowz with one fresh bluefin-reviewer agent for this item."
			: "Use workflowz with one fresh workpool item for this item.";
	switch (action.kind) {
		case "review":
			if (options?.isBlueberry) {
				return `Review ${cite(action.item)} in Blueberry advisory mode. Read the bounded diff with bluefin_review_diff and the recorded pipeline with bluefin_review_trace before judging. As a non-maintainer Blueberry contributor, donate your review to the project as an advisory submission. Format your review with \`[Blueberry Advisory Review | Model: ${options.model ?? "default"}]\` and submit it as a GitHub pull request comment or advisory review (\`gh pr review ${action.item.id} --repo ${action.item.repo} --comment -b "..."\`). Never approve, merge, or apply landing labels. ${authority} ${finish}`;
			}
			return `Review ${cite(action.item)}. Read bounded diffs and recorded pipelines before judging. Report findings by severity with file:line evidence, covering doctrine, correctness, security, tests, and simplicity. State explicitly what you verified and what you could not. ${authority} ${finish}`;
		case "slay":
		case "slay":
			return `Slay ${cite(item)} through autoreview. Use hive_workbench_diff and hive_workbench_trace, then report findings by severity with file:line evidence. ${workflow} ${authority} ${finish}`;
		case "diff":
			return `Call hive_workbench_diff for ${cite(item)} and summarize the changed files and concrete risks. ${workflow} ${authority} ${finish}`;
		case "fix":
			return item.type === "issue"
				? `Implement ${cite(item)} in an isolated workspace. Diagnose the root cause, make the smallest complete change, run focused verification, and open a review-ready pull request whose body contains \`Closes ${item.repo}#${item.id}\`. ${workflow} ${authority} ${finish}`
				: `Fix ${cite(item)} in an isolated workspace. Re-read the live diff and failing checks, diagnose each root cause, run focused verification, and push one clean commit for independent review. ${workflow} ${authority} ${finish}`;
		case "ci_mode":
			return `Activate CI monitor and repair mode. Ingest failing GitHub Actions workflow runs across configured repositories, cluster failures by root cause, batch repairs by repository starting with base image prerequisites, and monitor verification runs.`;
	}
}

/**
 * What the caller keeps after wiring the mode into a host.
 *
 * `session_start` returns before its own work is finished, so "the session has
 * started" and "the queue is on screen" are two different moments. Anything that
 * needs the second one — a test, a headless caller — awaits this.
 */
export interface ReviewExtension {
	whenStarted(): Promise<void>;
}

export function createReviewExtension(pi: ReviewExtensionHost, options: ExtensionOptions = {}): ReviewExtension {
	const env = options.env ?? process.env;
	const policy = options.policy ?? GENERIC_WORKBENCH_POLICY;
	const matchKey = options.matchKey;
	const mode = new ReviewMode({
		org: options.org ?? env.BLUEFIN_REVIEW_ORG ?? DEFAULT_ORG,
		fetchImpl: options.fetchImpl,
		env,
	});

	let tui: { requestRender(): void } | undefined;
	const timers: Array<() => void> = [];
	let dashboardOpen = false;
	let activeDashboard: ReviewDashboard | undefined;
	let activeCtx: CtxLike | undefined;
	let started: Promise<void> = Promise.resolve();
	let activeBatch: PersistedRepositoryBatch | undefined;
	let batchRequestGeneration = 0;
	let commentInFlight = false;
	pi.setLabel("Hive Workbench");
	pi.registerFlag("pr", { description: "Preselect a pull request or issue number", type: "string" });
	pi.registerFlag("issues", { description: "Start in issues mode instead of pull requests", type: "boolean", default: false });
	pi.registerFlag("all", { description: "Show all queue items instead of defaulting to Hive-only", type: "boolean", default: false });
	pi.registerFlag("repo", { description: "Review one repository: owner/repo, or org:name for a whole organization", type: "string" });
	pi.registerFlag("skip-repo", { description: "Comma-separated repositories to skip", type: "string" });
	pi.registerFlag("autoslay", { description: "Start mass autoreview immediately", type: "boolean", default: false });
	registerTools(pi as unknown as ToolHost, mode, () => started);

	const repaint = () => tui?.requestRender();

	const syncStatus = (ctx: CtxLike) => {
		if (!ctx.hasUI) return;
		const painter = workbenchPainter(ctx.ui.theme, () => mode.queueMode);
		if (dashboardOpen) ctx.ui.setStatus("hive_workbench", undefined);
		else ctx.ui.setStatus("hive_workbench", statusSegment(mode, painter, Date.now()));
		const activeItem = mode.selected();
		if (activeItem) {
			const kind = activeItem.type === "pr" ? "PR" : "ISSUE";
			const repo = activeItem.repo.includes("/") ? activeItem.repo.split("/")[1] : activeItem.repo;
			ctx.ui.setTitle(`hive workbench · ${kind} #${activeItem.id} (${repo}) ${activeItem.title}`);
		} else {
			ctx.ui.setTitle(`hive workbench · ${mode.queueMode} (${mode.position()})`);
		}
		repaint();
	};

	const every = (intervalMs: number, work: () => void) => {
		const handle = setInterval(() => {
			try {
				work();
			} catch {
				// Extensions share the session process; a throw from a timer is fatal.
			}
		}, intervalMs);
		(handle as { unref?(): void }).unref?.();
		timers.push(() => clearInterval(handle));
	};

	const refreshQueue = async (ctx: CtxLike) => {
		syncStatus(ctx);
		const result = await mode.refreshQueue();
		if (result.error && !result.cancelled && result.items.length === 0 && ctx.hasUI) {
			ctx.ui.notify(`Hive workbench queue: ${result.error}`, "error");
		}
		syncStatus(ctx);
		return result;
	};

	const persist = () => pi.appendEntry(STATE_ENTRY, mode.toPersisted());

	const syncBatchProgress = (ctx: CtxLike) => {
		if (!activeBatch) {
			mode.setBatchProgress(undefined);
			return;
		}
		const wave = activeBatch.waves[Math.min(activeBatch.currentWave, activeBatch.waves.length - 1)];
		const jobs = ctx.getAsyncJobSnapshot?.();
		const runningJobs = jobs?.running.filter((job) => job.startTime >= activeBatch!.waveStartedAt).length ?? 0;
		const failedJobs = jobs?.recent.filter(
			(job) => job.startTime >= activeBatch!.waveStartedAt && job.status === "failed",
		).length ?? 0;
		mode.setBatchProgress({
			state: activeBatch.state,
			repository: wave?.repo ?? "complete",
			wave: Math.min(activeBatch.currentWave + 1, activeBatch.waves.length),
			waves: activeBatch.waves.length,
			completedItems: activeBatch.completedItems,
			totalItems: activeBatch.totalItems,
			runningJobs,
			failedJobs,
		});
		repaint();
	};

	const persistBatch = (ctx: CtxLike, batch: PersistedRepositoryBatch) => {
		activeBatch = batch;
		pi.appendEntry(BATCH_ENTRY, batch);
		syncBatchProgress(ctx);
	};

	const batchBlocker = async (kind: RepositoryBatchKind, items: readonly QueueItem[]): Promise<string | undefined> => {
		if (kind === "slay" || kind === "diff") return undefined;
		const hive = await mode.refreshHive();
		if (!hive.online) return "Hive is unavailable; browse-only mode disables dispatch";
		const unranked = items.find((item) => mode.priorityFor(item)?.hiveRank === undefined);
		if (unranked) return `Hive did not rank ${unranked.repo}#${unranked.id}; browse-only mode disables dispatch`;
		const claimed = items.find((item) => mode.claimFor(item));
		if (claimed) return `${claimed.repo}#${claimed.id} is already claimed by ${mode.claimFor(claimed)}`;
		if (kind !== "fix") return undefined;

		const managedIssues = items.filter((item) => item.type === "issue" && managedPolicyFor(item.repo, policy));
		if (managedIssues.length > 0) {
			const result = await fetchIssueAdmission(
				managedIssues.map((item) => {
					const [owner, repo] = item.repo.split("/") as [string, string];
					return { owner, repo, number: item.id };
				}),
				{ token: mode.tokenOptions().token ?? resolveToken(env), fetchImpl: options.fetchImpl },
			);
			if (result.error) return `Admission check failed: ${result.error}`;
			for (const admitted of result.issues) {
				const key = `${admitted.owner}/${admitted.repo}#${admitted.number}`;
				const admissionPolicy = managedPolicyFor(`${admitted.owner}/${admitted.repo}`, policy);
				if (!admissionPolicy) return `Cannot dispatch ${key}: no managed-repository policy`;
				if (admitted.closed) return `Cannot dispatch ${key}: issue is closed`;
				if (admitted.labelsTruncated) return `Cannot dispatch ${key}: incomplete label evidence`;
				for (const denied of admissionPolicy.deniedLabels) {
					if (admitted.labels.includes(denied)) return `Cannot dispatch ${key}: issue has ${denied} label`;
				}
				for (const required of admissionPolicy.requiredLabels) {
					if (!admitted.labels.includes(required)) return `Cannot dispatch ${key}: missing explicit admission label '${required}'`;
				}
			}
		}

		const managedPullRequests = items.filter((item) => item.type === "pr" && managedPolicyFor(item.repo, policy));
		if (managedPullRequests.length > 0) {
			const live = await fetchItemsByKey(
				managedPullRequests.map((item) => `${item.repo}#${item.id}`),
				"prs",
				mode.tokenOptions(),
			);
			if (live.error) return `Live pull-request check failed: ${live.error}`;
			for (const item of managedPullRequests) {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return `Cannot dispatch ${item.repo}#${item.id}: pull request is closed or unreadable`;
				if (!current.headSha || current.headSha !== item.headSha) return `Cannot dispatch ${item.repo}#${item.id}: pull request head changed`;
				const denied = managedPolicyFor(item.repo, policy)?.deniedLabels.find((label) => current.labels.includes(label));
				if (denied) return `Cannot dispatch ${item.repo}#${item.id}: pull request has ${denied} label`;
			}
		}
		return undefined;
	};

	const dispatchCurrentWave = async (ctx: CtxLike, deliverAs?: "steer" | "followUp", prevalidated = false) => {
		if (!activeBatch) return;
		if (mode.paused) {
			persistBatch(ctx, { ...activeBatch, state: "paused" });
			return;
		}
		const wave = activeBatch.waves[activeBatch.currentWave];
		if (!wave) {
			persistBatch(ctx, { ...activeBatch, state: "complete" });
			ctx.ui.notify(activeBatch.kind === "slay" ? "Slay complete" : "Repository run complete", "info");
			return;
		}
		if (!prevalidated) {
			const blocker = await batchBlocker(activeBatch.kind, wave.items);
			if (blocker) {
				persistBatch(ctx, { ...activeBatch, state: "blocked", error: blocker });
				ctx.ui.notify(blocker, "error");
				return;
			}
		}
		const startedAt = Date.now();
		persistBatch(ctx, { ...activeBatch, state: "running", waveStartedAt: startedAt, error: undefined });
		const waveAction = {
			kind: activeBatch.kind,
			item: wave.items[0]!,
			items: wave.items.length > 1 ? [...wave.items] : undefined,
		} as DashboardAction;
		const prompt = actionPrompt(waveAction, mode.priorityFor(wave.items[0]!));
		if (!prompt) {
			persistBatch(ctx, { ...activeBatch!, state: "blocked", error: "wave action produced no prompt" });
			return;
		}
		ctx.ui.notify(`Dispatching ${wave.repo} wave ${activeBatch.currentWave + 1}/${activeBatch.waves.length}`, "info");
		pi.sendUserMessage(prompt, deliverAs ? { deliverAs } : undefined);
	};

	const startRepositoryBatch = async (ctx: CtxLike, kind: RepositoryBatchKind, items: readonly QueueItem[]) => {
		const generation = ++batchRequestGeneration;
		if (activeBatch?.state === "running" || activeBatch?.state === "paused") {
			ctx.ui.notify(`Run ${activeBatch.id} is already ${activeBatch.state}`, "warning");
			return;
		}
		const blocker = await batchBlocker(kind, items);
		if (generation !== batchRequestGeneration) return;
		if (activeBatch?.state === "running" || activeBatch?.state === "paused") return;
		if (blocker) {
			ctx.ui.notify(blocker, "error");
			return;
		}
		const waves = mode.repositoryWaves(items);
		if (waves.length === 0) return;
		const startedAt = Date.now();
		const batch: PersistedRepositoryBatch = {
			version: 1,
			id: `batch-${startedAt.toString(36)}`,
			kind,
			waves,
			currentWave: 0,
			completedItems: 0,
			totalItems: items.length,
			state: mode.paused ? "paused" : "running",
			startedAt,
			waveStartedAt: startedAt,
		};
		mode.clearSelected();
		persist();
		persistBatch(ctx, batch);
		await dispatchCurrentWave(ctx, undefined, true);
	};

	const startSlay = async (ctx: CtxLike) => {
		const chosen = mode.chosenItems();
		const items = (chosen.length > 0 ? chosen : mode.visibleItems()).slice(0, BATCH_LIMIT);
		if (items.length === 0) {
			ctx.ui.notify("No queue items available to slay", "warning");
			return;
		}
		await startRepositoryBatch(ctx, "slay", items);
	};

	/**
	 * Point the queue at another repository.
	 *
	 * Accepts `owner/repo`, a bare repository name in the configured
	 * organization, a GitHub URL, or `org:<name>` to go back to a whole
	 * organization. Anything else is rejected rather than silently searched for.
	 */
	const promptForScope = async (ctx: CtxLike): Promise<boolean> => {
		if (!ctx.hasUI) return false;
		const answer = await ctx.ui.input("Review which repository?", "owner/repo, or org:name");
		if (answer === undefined || !answer.trim()) return false;
		const scope = parseScope(answer, mode.org);
		if (!scope) {
			ctx.ui.notify(`Not a repository: ${answer.trim()}`, "error");
			return false;
		}
		mode.setScope(scope);
		ctx.ui.notify(`Queue scoped to ${mode.scopeLabel()}`, "info");
		await refreshQueue(ctx);
		persist();
		return true;
	};

	const dispatch = async (ctx: CtxLike, action: DashboardAction): Promise<void> => {
		if (action.kind === "close") return;
		if (action.kind === "scope") {
			await promptForScope(ctx);
			return;
		}
		if (action.kind === "reference") {
			const items = action.items && action.items.length > 0 ? action.items : [action.item];
			ctx.ui.pasteToEditor(items.map((item) => `${item.repo}#${item.id} — ${item.title}\n${item.url}\n`).join("\n"));
			return;
		}

		const capturedItems = action.items && action.items.length > 0 ? [...action.items] : [action.item];

		if (mode.isBlueberry) {
			const guard = assertBlueberryActionAllowed(action.kind, true);
			if (!guard.allowed) {
				ctx.ui.notify(guard.reason ?? "Action restricted in Blueberry Mode", "warning");
				return;
			}
		}

		if (action.kind === "comment") {
			if (commentInFlight) {
				ctx.ui.notify("A comment action is already in progress", "warning");
				return;
			}
			commentInFlight = true;
			let commentPlan: CommentActionPlan | undefined;
			const receipts: string[] = [];
			try {
				const body = await ctx.ui.editor("Comment on selected work", "");
				if (body === undefined || !body.trim()) return;
				const targets: CommentTargetSnapshot[] = capturedItems.map((item) => ({
					repo: item.repo,
					number: item.id,
					type: item.type === "pr" ? "pull_request" : "issue",
					headSha: item.headSha,
				}));
				commentPlan = createCommentActionPlan(targets, body);
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "previewed", plan: commentPlan } satisfies PersistedCommentResult);
				if (!(await ctx.ui.confirm("Post comment batch?", renderCommentActionPlan(commentPlan)))) {
					pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "aborted", plan: commentPlan } satisfies PersistedCommentResult);
					return;
				}

				const queueMode = capturedItems[0]!.type === "pr" ? "prs" : "issues";
				const live = await fetchItemsByKey(
					targets.map((target) => `${target.repo}#${target.number}`),
					queueMode,
					mode.tokenOptions(),
				);
				if (live.error) throw new Error(`live revalidation failed: ${live.error}`);
				const liveTargets: CommentTargetSnapshot[] = live.items.map((item) => ({
					repo: item.repo,
					number: item.id,
					type: item.type === "pr" ? "pull_request" : "issue",
					headSha: item.headSha,
				}));
				const validation = validateCommentActionPlan(commentPlan, liveTargets);
				if (!validation.valid) throw new Error(validation.errors.join("; "));
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "confirmed", plan: commentPlan } satisfies PersistedCommentResult);

				for (const target of commentPlan.targets) {
					if (receipts.length > 0) {
						const current = await fetchItemsByKey(
							[`${target.repo}#${target.number}`],
							target.type === "pull_request" ? "prs" : "issues",
							mode.tokenOptions(),
						);
						if (current.error) throw new Error(`live revalidation failed: ${current.error}`);
						const validation = validateCommentActionPlan(
							{ ...commentPlan, targets: [target] },
							current.items.map((item) => ({
								repo: item.repo,
								number: item.id,
								type: item.type === "pr" ? "pull_request" : "issue",
								headSha: item.headSha,
							})),
						);
						if (!validation.valid) throw new Error(validation.errors.join("; "));
					}
					const invocation = commentInvocation(target, commentPlan.body);
					const result = await pi.exec(invocation.command, [...invocation.args], { timeout: 30_000 });
					if (result.code !== 0 || result.killed) {
						throw new Error(result.stderr.trim() || `gh comment exited ${result.code}`);
					}
					receipts.push(result.stdout.trim() || `${target.repo}#${target.number}`);
					pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "confirmed", plan: commentPlan, receipts: [...receipts] } satisfies PersistedCommentResult);
				}
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "complete", plan: commentPlan, receipts } satisfies PersistedCommentResult);
				ctx.ui.notify(`Posted ${receipts.length} GitHub-confirmed comment${receipts.length === 1 ? "" : "s"}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (commentPlan) pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "failed", plan: commentPlan, receipts, error: message } satisfies PersistedCommentResult);
				ctx.ui.notify(`Comment action stopped: ${message}`, "error");
			} finally {
				commentInFlight = false;
			}
			return;
		}

		if (action.kind === "slay" || action.kind === "fix" || action.kind === "diff") {
			activeCtx = ctx;
			await startRepositoryBatch(ctx, action.kind, capturedItems);
		}
	};
	const openDashboard = async (ctx: CtxLike) => {
		if (!ctx.hasUI || dashboardOpen) return;
		dashboardOpen = true;
		let reopen = false;
		try {
			const action = await ctx.ui.custom<DashboardAction>(
				(hostTui, theme, _keybindings, done) => {
					tui = hostTui as { requestRender(): void };
					activeDashboard = new ReviewDashboard(
						tui,
						workbenchPainter(theme as UiLike["theme"], () => mode.queueMode),
						mode,
						done,
						() => void refreshQueue(ctx),
						Math.max(14, Math.min(30, (process.stdout.rows ?? 30) - 8)),
						matchKey,
						() => {
							persist();
							syncStatus(ctx);
						},
						(nextAction) => void dispatch(ctx, nextAction),
						(paused) => {
							persist();
							if (!paused && activeBatch?.state === "paused") void dispatchCurrentWave(ctx, "followUp");
							syncBatchProgress(ctx);
						},
					);
					return activeDashboard;
				},
				{ overlay: false },
			);
			if (action.kind === "scope") {
				await dispatch(ctx, action);
				reopen = true;
			}
		} catch {
			// OMP cancellation closes the workbench without changing batch state.
		} finally {
			dashboardOpen = false;
			activeDashboard = undefined;
			persist();
			syncStatus(ctx);
		}
		if (reopen) void openDashboard(ctx);
	};

	const startSession = async (ctx: CtxLike, persisted: PersistedSelection | undefined) => {
		const hive = await mode.refreshHive();
		if (hive.configured && hive.error) {
			ctx.ui.notify(`${hiveFailureStatus(hive.error)}; browse-only mode`, "warning");
		}
		await refreshQueue(ctx);
		mode.restore(persisted);

		const recoveredBatch = readPersistedBatch(ctx);
		if (recoveredBatch) {
			activeBatch = recoveredBatch.state === "running"
				? { ...recoveredBatch, state: "blocked", error: "session ended before the repository wave reached a terminal state" }
				: recoveredBatch;
			if (recoveredBatch.state === "running") pi.appendEntry(BATCH_ENTRY, activeBatch);
			if (activeBatch.state === "paused") mode.setPaused(true);
			syncBatchProgress(ctx);
		}
		const recoveredComment = readPersistedComment(ctx);
		if (recoveredComment?.state === "previewed" || recoveredComment?.state === "confirmed") {
			ctx.ui.notify("An interrupted comment plan was not replayed; inspect it before retrying", "warning");
		}

		const preselect = pi.getFlag("pr");
		if (typeof preselect === "string" && preselect.trim()) {
			const number = Number.parseInt(preselect.trim().replace(/^#/, ""), 10);
			if (Number.isInteger(number) && !mode.selectById(undefined, number)) {
				ctx.ui.notify(`#${number} is not in the open ${mode.queueMode} queue`, "warning");
			}
		}
		syncStatus(ctx);
		if (pi.getFlag("autoslay") === true) await startSlay(ctx);
		void openDashboard(ctx);
	};

	const advanceRepositoryBatch = async (ctx: CtxLike) => {
		if (!activeBatch || activeBatch.state !== "running") return;
		const wave = activeBatch.waves[activeBatch.currentWave];
		if (!wave) return;
		const jobs = ctx.getAsyncJobSnapshot?.();
		if (jobs?.running.some((job) => job.startTime >= activeBatch!.waveStartedAt)) return;
		const recent = jobs?.recent.filter((job) => job.startTime >= activeBatch!.waveStartedAt) ?? [];
		const failed = recent.filter((job) => job.status !== "completed");
		if (failed.length > 0 || recent.length === 0) {
			const error = failed.length > 0
				? `${failed.length} workflowz job${failed.length === 1 ? "" : "s"} failed or were cancelled`
				: "workflowz produced no observable jobs for the repository wave";
			persistBatch(ctx, { ...activeBatch, state: "blocked", error });
			ctx.ui.notify(`Repository wave stopped: ${error}`, "error");
			return;
		}
		const refreshed = await refreshQueue(ctx);
		if (refreshed.error) {
			persistBatch(ctx, { ...activeBatch, state: "blocked", error: refreshed.error });
			ctx.ui.notify(`Repository wave stopped: ${refreshed.error}`, "error");
			return;
		}
		const nextWave = activeBatch.currentWave + 1;
		const completedItems = activeBatch.completedItems + wave.items.length;
		if (nextWave >= activeBatch.waves.length) {
			persistBatch(ctx, { ...activeBatch, currentWave: nextWave, completedItems, state: "complete" });
			ctx.ui.notify(activeBatch.kind === "slay" ? "Slay complete" : "Repository run complete", "info");
			return;
		}
		persistBatch(ctx, {
			...activeBatch,
			currentWave: nextWave,
			completedItems,
			state: mode.paused ? "paused" : "running",
		});
		if (!mode.paused) await dispatchCurrentWave(ctx, "followUp");
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		mode.setToken(resolveToken(env));
		// Mode, scope and filter apply immediately; the remembered item can only be
		// found once the queue has actually been fetched, so restore runs twice.
		const persisted = readPersisted(ctx);
		mode.restore(persisted);

		const flagIssues = pi.getFlag("issues");
		if (flagIssues === true) mode.queueMode = "issues";

		const flagAll = pi.getFlag("all");
		if (flagAll === true) mode.hiveOnly = false;
		// An explicit scope beats a remembered one: you asked for it on the
		// command line, this run.
		const flagRepo = pi.getFlag("repo");
		if (typeof flagRepo === "string" && flagRepo.trim()) {
			const scope = parseScope(flagRepo, mode.org);
			if (scope) mode.setScope(scope);
			else if (ctx.hasUI) ctx.ui.notify(`--repo is not a repository: ${flagRepo}`, "error");
		}
		const flagSkipRepo = pi.getFlag("skip-repo");
		if (typeof flagSkipRepo === "string" && flagSkipRepo.trim()) {
			for (const r of flagSkipRepo.split(",")) {
				const trimmed = r.trim().toLowerCase();
				if (trimmed) mode.skipRepos.add(trimmed);
			}
		}
		if (!ctx.hasUI) {
			// No UI, so no frame can show an unranked queue: the two reads race
			// safely, and both reprioritize on arrival. Nothing is awaited here
			// either — the queue tools await `started` themselves, which is what a
			// headless caller actually needs and what the handler budget allows.
			started = Promise.all([mode.refreshHive(), refreshQueue(ctx)])
				.then(() => {
					mode.restore(persisted);
				})
				.catch(() => {
					// fetchHive and fetchQueue report failure in their results; a
					// throw here must still leave `started` resolvable for the tools.
				});
			return;
		}

		ctx.ui.setTitle("hive workbench");
		ctx.ui.setWidget(
			"hive-workbench-rail",
			(hostTui: unknown, theme: unknown) => {
				tui = hostTui as { requestRender(): void };
				return new ReviewRail(
					tui,
					workbenchPainter(theme as UiLike["theme"], () => mode.queueMode),
					mode,
					RAIL_KEYS,
					() => dashboardOpen,
				);
			},
			{ placement: "belowEditor" },
		);

		syncStatus(ctx);

		// Before the first await: a startup that fails or drags must still leave a
		// session that refreshes itself.
		every(QUEUE_POLL_MS, () => {
			void refreshQueue(ctx);
		});
		every(HIVE_POLL_MS, () => {
			void mode.refreshHive().then(() => {
				syncStatus(ctx);
			});
		});

		// Detached: nothing awaits this, so an escaping rejection would take the
		// whole session process down with it.
		started = startSession(ctx, persisted).catch((error: unknown) => {
			ctx.ui.notify(`Hive workbench startup: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	});

	pi.on("session_shutdown", () => {
		for (const stop of timers.splice(0)) stop();
	});

	// ---- live turn trace -----------------------------------------------------

	pi.on("turn_start", (_event, eventCtx) => {
		mode.session.startTurn(Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) syncBatchProgress(ctxToUse);
		repaint();
	});
	pi.on("turn_end", (_event, eventCtx) => {
		mode.session.endTurn(Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) syncBatchProgress(ctxToUse);
		repaint();
	});
	pi.on("agent_end", async (event, eventCtx) => {
		if (event && typeof event === "object" && "willContinue" in event && event.willContinue === true) return;
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) await advanceRepositoryBatch(ctxToUse);
	});
	pi.on("tool_execution_start", (event) => {
		const { toolCallId, toolName, args } = event as { toolCallId: string; toolName: string; args: unknown };
		mode.session.startTool(toolCallId, toolName, args, Date.now());
		repaint();
	});
	pi.on("tool_execution_update", (event) => {
		const { toolCallId, partialResult } = event as { toolCallId: string; partialResult: unknown };
		mode.session.updateTool(toolCallId, partialResult);
		repaint();
	});
	pi.on("tool_execution_end", (event, eventCtx) => {
		const { toolCallId, result, isError } = event as { toolCallId: string; result: unknown; isError: boolean };
		mode.session.endTool(toolCallId, result, isError === true, Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) syncBatchProgress(ctxToUse);
		repaint();
	});

	// ---- keyboard ------------------------------------------------------------

	pi.registerShortcut("alt+b", {
		description: "Open the Hive workbench",
		handler: (ctx) => void openDashboard(ctx),
	});
	pi.registerShortcut("alt+s", {
		description: "Slay the selected or visible queue through mass autoreview",
		handler: (ctx) => void startSlay(ctx),
	});
	pi.registerShortcut("alt+u", {
		description: "Refetch the Hive workbench queue",
		handler: (ctx) => void refreshQueue(ctx),
	});

	return { whenStarted: () => started };
}
