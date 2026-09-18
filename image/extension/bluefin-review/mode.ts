/**
 * Mode state: the single source of truth every surface reads.
 *
 * The status segment, the rail under the editor, the dashboard overlay, and the
 * LLM tools all project this one object. Nothing here touches the TUI, so the
 * whole model is testable without a terminal.
 */

import { GLYPH, type SpanStatus, statusIcon } from "./glyphs.ts";
import {
	type FetchOptions,
	type QueueItem,
	type QueueMode,
	type QueueResult,
	type QueueScope,
	fetchItemsByKey,
	fetchQueue,
	orgScope,
} from "./github.ts";
import { type HiveSnapshot, type HiveWorkItem, EMPTY_HIVE, fetchHive, fetchHiveKnowledge, fetchHiveMe } from "./hive.ts";
import { type PrioritizedQueue, type Priority, isRepairRequested, itemKey, prioritize } from "./priority.ts";
import { type LandingState, landingState } from "./landing.ts";
import { GENERIC_WORKBENCH_POLICY, type WorkbenchPolicy } from "./policy.ts";
import { SessionTrace } from "./session.ts";

export interface ReviewModeOptions {
	org: string;
	token?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	/** Managed-repository policy, so landing state honours the same holds as the gate. */
	policy?: WorkbenchPolicy;
}
/**
 * Most items one dispatch may carry.
 *
 * A batch is fanned out one agent per item, so this is a concurrency ceiling
 * wearing a selection's clothes. Past it the wave stops being a burn-down and
 * starts being a queue of its own, with a context window to match.
 */
export const BATCH_LIMIT = 25;

const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/;

function pullRequestKey(item: HiveWorkItem): string | undefined {
	const direct = GITHUB_PULL_URL.exec(item.url);
	if (direct) return `${direct[1]}#${direct[2]}`;
	if (!item.pr || item.pr.state.toLowerCase() !== "open") return undefined;
	const linked = GITHUB_PULL_URL.exec(item.pr.url);
	return linked ? `${linked[1]}#${linked[2]}` : `${item.repo}#${item.pr.number}`;
}

/** A contiguous slice of work targeting a single repository. */
export interface RepositoryWave {
	readonly repo: string;
	readonly items: readonly QueueItem[];
}

export interface WorkbenchBatchProgress {
	readonly state: "running" | "paused" | "blocked" | "complete";
	readonly repository: string;
	readonly wave: number;
	readonly waves: number;
	readonly completedItems: number;
	readonly totalItems: number;
	readonly runningJobs: number;
	readonly failedJobs: number;
}

/** Shape persisted to the session so a resumed session reopens where it left off. */
export interface PersistedSelection {
	mode: QueueMode;
	repo?: string;
	id?: number;
	filter?: string;
	hiveOnly?: boolean;
	hiveLevel?: string;
	scope?: QueueScope;
	paused?: boolean;
}

export class ReviewMode {
	readonly org: string;

	queueMode: QueueMode = "prs";
	scope: QueueScope;
	items: QueueItem[] = [];
	cursor = 0;
	filter = "";
	hiveOnly = false;
	/** Hive triage stage the queue is drilled into; undefined is all of it. */
	hiveLevel?: string;
	queueError?: string;
	queueTruncated = false;
	fetchedAt = 0;
	loading = false;
	selectedKeys = new Set<string>();
	currentUserLogin?: string;
	viewMode: "default" | "ci" = "default";
	isBlueberry = false;
	paused = false;
	batchProgress?: WorkbenchBatchProgress;

	hive: HiveSnapshot = EMPTY_HIVE;
	readonly session = new SessionTrace();

	private token?: string;
	private fetchImpl?: typeof fetch;
	private env: NodeJS.ProcessEnv;
	private policy: WorkbenchPolicy;
	private inflight?: AbortController;
	private ranked: PrioritizedQueue = { items: [], priorities: new Map(), source: "local", hiveRanked: 0 };
	skipRepos: Set<string>;

	constructor(options: ReviewModeOptions) {
		this.org = options.org;
		this.scope = orgScope(options.org);
		this.token = options.token;
		this.fetchImpl = options.fetchImpl;
		this.env = options.env ?? process.env;
		this.policy = options.policy ?? GENERIC_WORKBENCH_POLICY;
		const envSkip = (this.env.BLUEFIN_REVIEW_SKIP_REPOS ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		this.skipRepos = new Set(envSkip);
	}

	setToken(token: string | undefined): void {
		this.token = token;
	}


	/** Credential and transport for one-off calls that bypass the queue poll. */
	tokenOptions(): FetchOptions {
		return { token: this.token, org: this.org, scope: this.scope, fetchImpl: this.fetchImpl };
	}

	/** What the queue currently covers, for display. */
	scopeLabel(): string {
		return this.scope.value;
	}

	/** Point the queue at another organization or repository. */
	setScope(scope: QueueScope): void {
		this.inflight?.abort();
		this.inflight = undefined;
		this.loading = false;
		this.scope = scope;
		this.cursor = 0;
		this.items = [];
		this.ranked = { items: [], priorities: new Map(), source: "local", hiveRanked: 0 };
		this.queueError = undefined;
		this.queueTruncated = false;
	}

	/** Why this item sits where it sits. */
	priorityFor(item: QueueItem): Priority | undefined {
		return this.ranked.priorities.get(itemKey(item));
	}

	priorities(): ReadonlyMap<string, Priority> {
		return this.ranked.priorities;
	}

	/**
	 * Authoritative landing state for a pull request: CI, reviews, holds, and
	 * mergeability evaluated together. Only the extension and the status tool
	 * project this, so the UI maps to the same state the slay gate enforces.
	 */
	landingStateFor(item: QueueItem): LandingState {
		return landingState(item, this.policy);
	}

	/** Which provider ordered the queue: Hive's priority, or local categories. */
	orderSource(): "hive" | "local" {
		return this.ranked.source;
	}

	hiveRankedCount(): number {
		return this.ranked.hiveRanked;
	}

	/**
	 * Recompute the order.
	 *
	 * Cheap and idempotent, so every input that can change priority — a queue
	 * refetch, a hub poll, a new receipt on disk — ends by calling it.
	 */
	reprioritize(now = Date.now()): void {
		this.ranked = prioritize(this.items, {
			hive: this.hive,
			now,
			currentUserLogin: this.currentUserLogin,
		});
	}

	/**
	 * The Hive work item behind a queue row, if there is one.
	 *
	 * A pull request is rarely queued by Hive directly, so the link is usually
	 * the issue it closes — the same path `hiveRankFor` ranks it through.
	 */
	hiveWorkFor(item: QueueItem): HiveWorkItem | undefined {
		const keys = [itemKey(item), ...(item.closingIssues ?? [])];
		for (const key of keys) {
			const match = this.hive.items.find((candidate) => candidate.key === key);
			if (match) return match;
		}
		return undefined;
	}

	/** Hive's triage levels, in the hub's own order, for stepping through. */
	hiveLevels(): string[] {
		return this.hive.triage.map((group) => group.level).filter(Boolean);
	}

	/**
	 * Step the queue to Hive's next triage stage, then back to all of it.
	 *
	 * Drilling down a backlog is stage by stage — what is ready to implement is a
	 * different sitting from what is still being triaged.
	 */
	cycleHiveLevel(): string | undefined {
		const levels = this.hiveLevels();
		if (levels.length === 0) {
			this.hiveLevel = undefined;
			return undefined;
		}
		const at = this.hiveLevel === undefined ? -1 : levels.indexOf(this.hiveLevel);
		this.hiveLevel = at + 1 >= levels.length ? undefined : levels[at + 1];
		this.cursor = 0;
		return this.hiveLevel;
	}

	/** The contributor whose worker holds this item right now, if any. */
	claimFor(item: QueueItem): string | undefined {
		for (const key of [itemKey(item), ...(item.closingIssues ?? [])]) {
			const who = this.hive.claims.get(key);
			if (who) return who;
		}
		return undefined;
	}

	/** Items in priority order, after hive-only, level, and substring filters. */
	visibleItems(): QueueItem[] {
		let base = this.ranked.items.length === this.items.length ? this.ranked.items : this.items;
		if (this.skipRepos.size > 0) {
			base = base.filter((item) => {
				const repoLower = item.repo.toLowerCase();
				const shortName = repoLower.includes("/") ? repoLower.split("/")[1]! : repoLower;
				return !this.skipRepos.has(repoLower) && !this.skipRepos.has(shortName);
			});
		}
		let candidates = this.hiveOnly && this.hive.online
			? base.filter((item) => this.priorityFor(item)?.category === "hive")
			: base;
		if (this.hiveLevel !== undefined) {
			const level = this.hiveLevel;
			candidates = candidates.filter((item) => this.hiveWorkFor(item)?.level === level);
		}
		if (!this.filter) return candidates;
		const needle = this.filter.toLowerCase();
		return candidates.filter(
			(item) =>
				item.title.toLowerCase().includes(needle) ||
				item.repo.toLowerCase().includes(needle) ||
				item.author.toLowerCase().includes(needle) ||
				String(item.id).includes(needle) ||
				item.labels.some((label) => label.toLowerCase().includes(needle)) ||
				(this.priorityFor(item)?.category ?? "").includes(needle) ||
				(this.hiveWorkFor(item)?.level ?? "").includes(needle),
		);
	}

	selected(): QueueItem | undefined {
		const items = this.visibleItems();
		if (items.length === 0) return undefined;
		if (this.cursor >= items.length) this.cursor = items.length - 1;
		return items[Math.max(0, this.cursor)];
	}

	selectedKey(): string | undefined {
		const item = this.selected();
		return item ? itemKey(item) : undefined;
	}

	move(delta: number): void {
		const count = this.visibleItems().length;
		if (count === 0) {
			this.cursor = 0;
			return;
		}
		this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
	}

	selectById(repo: string | undefined, id: number): boolean {
		const items = this.visibleItems();
		const index = items.findIndex((item) => item.id === id && (!repo || item.repo === repo));
		if (index < 0) return false;
		this.cursor = index;
		return true;
	}

	setFilter(filter: string): void {
		this.filter = filter;
		this.cursor = 0;
	}
	toggleHiveOnly(): boolean {
		this.hiveOnly = !this.hiveOnly;
		this.cursor = 0;
		return this.hiveOnly;
	}
	setPaused(paused: boolean): void {
		this.paused = paused;
	}
	togglePaused(): boolean {
		this.paused = !this.paused;
		return this.paused;
	}
	setBatchProgress(progress: WorkbenchBatchProgress | undefined): void {
		this.batchProgress = progress;
	}
	toggleMode(): QueueMode {
		this.queueMode = this.queueMode === "prs" ? "issues" : "prs";
		this.items = [];
		this.cursor = 0;
		this.selectedKeys.clear();
		return this.queueMode;
	}
	toggleViewMode(): "default" | "ci" {
		this.viewMode = this.viewMode === "default" ? "ci" : "default";
		return this.viewMode;
	}
	setBlueberry(isBlueberry: boolean): void {
		this.isBlueberry = isBlueberry;
	}


	toggleSelected(key?: string): boolean {
		const targetKey = key ?? this.selectedKey();
		if (!targetKey) return false;
		if (this.selectedKeys.has(targetKey)) {
			this.selectedKeys.delete(targetKey);
			return false;
		}
		this.selectedKeys.add(targetKey);
		return true;
	}

	/**
	 * Take everything currently on screen, or drop it.
	 *
	 * Burning a backlog down means dispatching a slice at a time, and a slice is
	 * whatever the filters have narrowed the queue to. Selecting it one row at a
	 * time is the reason nobody does it. Returns the resulting selection size.
	 */
	selectAllVisible(limit = BATCH_LIMIT): number {
		const visible = this.visibleItems();
		const everySelected = visible.length > 0 && visible.every((item) => this.selectedKeys.has(itemKey(item)));
		if (everySelected) {
			this.selectedKeys.clear();
			return 0;
		}
		for (const item of visible.slice(0, limit)) this.selectedKeys.add(itemKey(item));
		return this.selectedKeys.size;
	}
	/**
	 * Toggles selection of all visible items in the current selected repository.
	 * Leaves selections in other repositories untouched.
	 * Respects global BATCH_LIMIT.
	 */
	selectCurrentRepository(limit = BATCH_LIMIT): number {
		const current = this.selected();
		if (!current) return this.selectedKeys.size;
		const repo = current.repo;
		const repoVisible = this.visibleItems().filter((item) => item.repo === repo);
		if (repoVisible.length === 0) return this.selectedKeys.size;
		const allRepoSelected = repoVisible.every((item) => this.selectedKeys.has(itemKey(item)));
		if (allRepoSelected) {
			for (const item of repoVisible) {
				this.selectedKeys.delete(itemKey(item));
			}
			return this.selectedKeys.size;
		}
		const availableSlots = Math.max(0, limit - this.selectedKeys.size);
		let added = 0;
		for (const item of repoVisible) {
			const key = itemKey(item);
			if (!this.selectedKeys.has(key)) {
				if (added >= availableSlots) break;
				this.selectedKeys.add(key);
				added += 1;
			}
		}
		return this.selectedKeys.size;
	}

	/**
	 * Partition items into bounded, type-homogeneous repository waves without
	 * moving any item ahead of work ordered before it. Returned PR repairs stay
	 * separate from ordinary PR review/landing waves.
	 */
	repositoryWaves(items: readonly QueueItem[] = this.chosenItems()): RepositoryWave[] {
		const waves: Array<{ repo: string; items: QueueItem[] }> = [];
		for (const item of items) {
			const previous = waves.at(-1);
			const first = previous?.items[0];
			const sameIntent = first !== undefined
				&& first.type === item.type
				&& isRepairRequested(first, this.currentUserLogin) === isRepairRequested(item, this.currentUserLogin);
			if (previous?.repo === item.repo && sameIntent && previous.items.length < BATCH_LIMIT) {
				previous.items.push(item);
				continue;
			}
			waves.push({ repo: item.repo, items: [item] });
		}
		return waves;
	}

	clearSelected(): void {
		this.selectedKeys.clear();
	}

	chosenItems(): QueueItem[] {
		if (this.selectedKeys.size === 0) return [];
		return this.visibleItems().filter((item) => this.selectedKeys.has(`${item.repo}#${item.id}`));
	}


	/** Pull requests authored by the active user after a requested-changes review. */
	repairRequestedItems(): QueueItem[] {
		return this.visibleItems().filter((item) => isRepairRequested(item, this.currentUserLogin));
	}
	/**
	 * Items available for slay execution: chosen items first, then visible items,
	 * falling back to unranked items in local priority order when the Hive-only
	 * filter leaves zero items.
	 *
	 * `exclude` drops already-attempted work at every tier before the limit is
	 * applied, which is what lets an unattended run take a genuinely new batch
	 * each pass instead of re-selecting the same head of the queue forever.
	 */
	slayableItems(limit = BATCH_LIMIT, exclude?: ReadonlySet<string>): QueueItem[] {
		const keep = (items: QueueItem[]): QueueItem[] =>
			exclude === undefined ? items : items.filter((item) => !exclude.has(itemKey(item)));
		const chosen = keep(this.chosenItems());
		if (chosen.length > 0) return chosen.slice(0, limit);
		const visible = keep(this.visibleItems());
		if (visible.length > 0) return visible.slice(0, limit);
		let base = this.ranked.items.length === this.items.length ? this.ranked.items : this.items;
		if (this.skipRepos.size > 0) {
			base = base.filter((item) => {
				const repoLower = item.repo.toLowerCase();
				const shortName = repoLower.includes("/") ? repoLower.split("/")[1]! : repoLower;
				return !this.skipRepos.has(repoLower) && !this.skipRepos.has(shortName);
			});
		}
		return keep(base).slice(0, limit);
	}



	/**
	 * Ask the hub what the project needs first.
	 *
	 * Read-only and never fatal: an unreachable hub leaves the queue ordered by
	 * the local categories, with the reason kept for display.
	 */
	async refreshHive(signal?: AbortSignal): Promise<HiveSnapshot> {
		this.hive = await fetchHive({ env: this.env, signal, fetchImpl: this.fetchImpl });
		this.reprioritize();
		return this.hive;
	}
	/**
	 * Programmatically fetch the authenticated Hive knowledge base markdown export.
	 */
	async getHiveKnowledge(signal?: AbortSignal): Promise<string | undefined> {
		return await fetchHiveKnowledge({ env: this.env, signal, fetchImpl: this.fetchImpl });
	}

	async getHiveMe(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
		return await fetchHiveMe({ env: this.env, signal, fetchImpl: this.fetchImpl });
	}

	/**
	 * Fetch the queue, cancelling any fetch still in flight.
	 *
	 * Two sources, one queue: a search for what is nearby, then Hive's own work
	 * by name. The search alone cannot serve Hive — it is ordered by recency and
	 * cut off by a ceiling, and Hive's backlog is neither recent nor small.
	 */
	async refreshQueue(): Promise<QueueResult> {
		this.inflight?.abort();
		const controller = new AbortController();
		this.inflight = controller;
		this.loading = true;

		try {
			const options: FetchOptions = {
				token: this.token,
				org: this.org,
				scope: this.scope,
				signal: controller.signal,
				fetchImpl: this.fetchImpl,
			};
			const result = await fetchQueue(this.queueMode, options);
			if (result.cancelled || this.inflight !== controller || controller.signal.aborted) {
				return { items: result.items, cancelled: true, fetchedAt: result.fetchedAt };
			}

			if (result.error && result.items.length === 0) {
				this.queueError = result.error;
				this.queueTruncated = result.truncated === true;
				this.fetchedAt = result.fetchedAt;
				return result;
			}

			const missing = await this.missingHiveWork(result.items, options, controller);
			if (this.inflight !== controller || controller.signal.aborted) {
				return { items: result.items, cancelled: true, fetchedAt: result.fetchedAt };
			}

			this.queueError = result.error;
			this.queueTruncated = result.truncated === true;
			this.fetchedAt = result.fetchedAt;
			if (result.viewerLogin) this.currentUserLogin = result.viewerLogin;
			const previousKey = this.selectedKey();
			this.items = [...result.items, ...missing];
			this.reprioritize();
			if (previousKey) {
				const index = this.visibleItems().findIndex((item) => itemKey(item) === previousKey);
				this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.visibleItems().length - 1));
			}
			return result;
		} finally {
			if (this.inflight === controller) {
				this.loading = false;
				this.inflight = undefined;
			}
		}
	}

	/**
	 * Hive's queued work that the search did not return.
	 *
	 * Scope is respected: a repository-scoped queue stays that repository's, so
	 * asking for one project never drags in another project's Hive work.
	 */
	private hiveKeysForMode(): string[] {
		const keys = new Set<string>();
		for (const item of this.hive.items) {
			if (this.queueMode === "issues") {
				if (!GITHUB_PULL_URL.test(item.url) && this.inScope(item.key)) keys.add(item.key);
				continue;
			}

			const key = pullRequestKey(item);
			if (key && this.inScope(key)) keys.add(key);
		}
		return [...keys];
	}

	private async missingHiveWork(
		fetched: readonly QueueItem[],
		options: FetchOptions,
		controller: AbortController,
	): Promise<QueueItem[]> {
		if (this.inflight !== controller || controller.signal.aborted || !this.hive.online) return [];
		const present = new Set(fetched.map(itemKey));
		const wanted = this.hiveKeysForMode().filter((key) => !present.has(key));
		if (wanted.length === 0) return [];
		const result = await fetchItemsByKey(wanted, this.queueMode, options);
		if (this.inflight !== controller || controller.signal.aborted) return [];
		return result.items;
	}

	private inScope(key: string): boolean {
		const repo = key.slice(0, key.indexOf("#"));
		return this.scope.kind === "org" ? repo.startsWith(`${this.scope.value}/`) : repo === this.scope.value;
	}

	/**
	 * How much of Hive's mode-matching queue this session can actually act on.
	 *
	 * Issue mode covers Hive's issue keys. Pull-request mode covers direct Hive
	 * pull requests, explicit open linked pull requests, and pull requests the
	 * GitHub search already linked to ranked issues through closing references.
	 */
	hiveCoverage(): { present: number; total: number } {
		const expected = new Set(this.hiveKeysForMode());
		for (const item of this.items) {
			if (this.priorityFor(item)?.source === "hive") expected.add(itemKey(item));
		}
		return { present: this.hiveRankedCount(), total: expected.size };
	}


	/** CI histogram across the visible queue, for the headline counters. */
	ciTally(): { success: number; failure: number; pending: number; unknown: number } {
		const tally = { success: 0, failure: 0, pending: 0, unknown: 0 };
		for (const item of this.visibleItems()) {
			if (item.ciStatus === "success") tally.success += 1;
			else if (item.ciStatus === "failure") tally.failure += 1;
			else if (item.ciStatus === "pending") tally.pending += 1;
			else tally.unknown += 1;
		}
		return tally;
	}

	position(): string {
		const count = this.visibleItems().length;
		if (count === 0) return "0/0";
		// A trailing "+" marks a queue cut off by the fetch ceiling.
		const total = `${count}${this.queueTruncated && !this.filter ? "+" : ""}`;
		return `${Math.min(this.cursor + 1, count)}/${total}`;
	}

	toPersisted(): PersistedSelection {
		const item = this.selected();
		return {
			mode: this.queueMode,
			repo: item?.repo,
			id: item?.id,
			filter: this.filter || undefined,
			hiveOnly: this.hiveOnly,
			hiveLevel: this.hiveLevel,
			scope: this.scope,
			paused: this.paused ? true : undefined,
		};
	}

	restore(persisted: PersistedSelection | undefined): void {
		if (!persisted) return;
		if (persisted.mode === "prs" || persisted.mode === "issues") this.queueMode = persisted.mode;
		if (persisted.scope?.value && (persisted.scope.kind === "org" || persisted.scope.kind === "repo")) {
			this.scope = persisted.scope;
		}
		if (persisted.filter) this.filter = persisted.filter;
		if (typeof persisted.hiveOnly === "boolean") this.hiveOnly = persisted.hiveOnly;
		if (typeof persisted.hiveLevel === "string") this.hiveLevel = persisted.hiveLevel;
		if (typeof persisted.id === "number") this.selectById(persisted.repo, persisted.id);
		if (typeof persisted.paused === "boolean") this.paused = persisted.paused;
	}
}

/** CI badge in the Dagger icon vocabulary. */
export function ciGlyph(status: QueueItem["ciStatus"]): { glyph: string; status: SpanStatus } {
	switch (status) {
		case "success":
			return { glyph: statusIcon("success"), status: "success" };
		case "failure":
			return { glyph: statusIcon("failure"), status: "failure" };
		case "pending":
			return { glyph: GLYPH.running, status: "running" };
		default:
			return { glyph: GLYPH.pending, status: "pending" };
	}
}
