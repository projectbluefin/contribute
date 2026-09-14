/**
 * What to look at first.
 *
 * Hive rank is authoritative whenever the hub is online. Unranked items keep
 * their fetched GitHub order for browse-only evidence; their category is a
 * description, never a dispatch priority. This module therefore cannot select,
 * assign, or promote work independently of Hive.
 */

import type { QueueItem } from "./github.ts";
import type { HiveSnapshot } from "./hive.ts";

export type PriorityCategory =
	| "hive"
	| "ready-for-human-merge"
	| "review"
	| "resolve-conflicts"
	| "fix-ci"
	| "investigate"
	| "triage";

export interface Priority {
	category: PriorityCategory;
	source: "hive" | "local";
	/** Short human reason, shown next to the item. */
	reason: string;
	/** Hive's own position, when Hive supplied it. */
	hiveRank?: number;
	/** Sinks bot bumps and abandoned branches within their category. */
	demotion: number;
}

export interface PrioritizeContext {
	hive: HiveSnapshot;
	now: number;
}

export interface PrioritizedQueue {
	items: QueueItem[];
	priorities: ReadonlyMap<string, Priority>;
	source: "hive" | "local";
	/** How many items Hive ranked, for the headline. */
	hiveRanked: number;
}

/**
 * The order a maintainer wants, which is not the order GitHub returns.
 *
 * A queue that buries what you can land under sixty things you cannot is a queue
 * you stop reading.
 */
const MAINTAINER_ORDER: Record<PriorityCategory, number> = {
	hive: 0,
	"ready-for-human-merge": 1,
	review: 2,
	"resolve-conflicts": 3,
	"fix-ci": 4,
	investigate: 5,
	triage: 6,
};

const STALE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;

const BOT_AUTHORS: Record<string, true> = {
	renovate: true,
	"renovate[bot]": true,
	dependabot: true,
	"dependabot[bot]": true,
	mergeraptor: true,
	"github-actions[bot]": true,
};

const DEPENDENCY_LABELS = /(^|[/-])(deps|dependencies|dependency)([/-]|$)/i;

export function itemKey(item: QueueItem): string {
	return `${item.repo}#${item.id}`;
}

export function isDependencyBump(item: QueueItem): boolean {
	if (BOT_AUTHORS[item.author.toLowerCase()]) return true;
	if (item.labels.some((label) => DEPENDENCY_LABELS.test(label))) return true;
	return /^chore\(deps\)/i.test(item.title);
}

/**
 * The local fallback: the dashboard's classifier, first match wins.
 *
 * A failing check is actionable before a conflict is, and only a green,
 * approved pull request is ready for a human merge. A draft waits on its
 * author.
 */
export function categorize(item: QueueItem, context: PrioritizeContext): { category: PriorityCategory; reason: string } {
	if (item.type === "issue") return { category: "triage", reason: "issue awaiting triage" };
	if (item.draft) return { category: "investigate", reason: "draft, waiting on its author" };
	if (item.ciStatus === "failure") return { category: "fix-ci", reason: "checks failing" };
	if (item.mergeState === "dirty") return { category: "resolve-conflicts", reason: "conflicts with the base" };
	if (item.ciStatus === undefined || item.ciStatus === "pending") {
		return { category: "investigate", reason: item.ciStatus === "pending" ? "checks still running" : "no checks reported" };
	}
	if (item.mergeState === "unknown" || item.reviewState === "unknown") {
		return { category: "investigate", reason: "incomplete evidence from GitHub" };
	}
	if (item.reviewState === "approved") return { category: "ready-for-human-merge", reason: "green and approved" };
	return { category: "review", reason: "green, awaiting review" };
}

/**
 * Within a category, what sinks.
 *
 * A dependency bump is real work but it is never the thing a maintainer should
 * read first, and a branch nobody has touched in three weeks is not urgent
 * because its checks happen to be green.
 */
export function demotionFor(item: QueueItem, now: number): number {
	let demotion = 0;
	if (isDependencyBump(item)) demotion += 1;
	if (item.updatedAt > 0 && now - item.updatedAt > STALE_AFTER_MS) demotion += 2;
	return demotion;
}

/**
 * Hive's rank for an item.
 *
 * A pull request is rarely queued by Hive directly — Hive queues the issue. The
 * link is the pull request's own closing references, so a change that closes
 * prioritized work inherits that priority instead of sinking into date order.
 */
export function hiveRankFor(item: QueueItem, hive: HiveSnapshot): number | undefined {
	const candidates = [itemKey(item), ...(item.closingIssues ?? [])];
	let best: number | undefined;
	for (const key of candidates) {
		const rank = hive.ranks.get(key);
		if (rank === undefined) continue;
		if (best === undefined || rank < best) best = rank;
	}
	return best;
}

function hiveReason(item: QueueItem, hive: HiveSnapshot, rank: number): string {
	const match = hive.items.find(
		(candidate) => candidate.key === itemKey(item) || (item.closingIssues ?? []).includes(candidate.key),
	);
	const level = match?.level;
	const via = match && match.key !== itemKey(item) ? ` via ${match.key}` : "";
	return level ? `hive ${level} #${rank + 1}${via}` : `hive #${rank + 1}${via}`;
}

/**
 * Preserve Hive's order when it is available. Without Hive, retain GitHub's
 * fetched order for browse-only evidence; local categories remain descriptive
 * and never become dispatch authority.
 */
export function prioritize(items: readonly QueueItem[], context: PrioritizeContext): PrioritizedQueue {
	const priorities = new Map<string, Priority>();
	let hiveRanked = 0;
	const inputOrder = new Map<string, number>();

	for (const item of items) {
		const key = itemKey(item);
		inputOrder.set(key, inputOrder.size);
		const demotion = demotionFor(item, context.now);
		const rank = context.hive.online ? hiveRankFor(item, context.hive) : undefined;
		if (rank !== undefined) {
			hiveRanked += 1;
			priorities.set(key, {
				category: "hive",
				source: "hive",
				reason: hiveReason(item, context.hive, rank),
				hiveRank: rank,
				demotion: 0,
			});
			continue;
		}
		const { category, reason } = categorize(item, context);
		priorities.set(key, { category, source: "local", reason, demotion });
	}

	if (!context.hive.online) {
		return { items: [...items], priorities, source: "local", hiveRanked: 0 };
	}

	const ordered = [...items].sort((left, right) => {
		const a = priorities.get(itemKey(left))!;
		const b = priorities.get(itemKey(right))!;
		if (a.hiveRank !== undefined || b.hiveRank !== undefined) {
			// Hive-ranked work always precedes unranked work, in Hive's order.
			if (a.hiveRank === undefined) return 1;
			if (b.hiveRank === undefined) return -1;
			if (a.hiveRank !== b.hiveRank) return a.hiveRank - b.hiveRank;
		}

		// Hive supplied no relative order for either item. Preserve GitHub's
		// fetched order; local categories are descriptive, never a second priority.
		return inputOrder.get(itemKey(left))! - inputOrder.get(itemKey(right))!;
	});

	return {
		items: ordered,
		priorities,
		source: "hive",
		hiveRanked,
	};
}
