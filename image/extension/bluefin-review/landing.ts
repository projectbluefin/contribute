/**
 * Landing state: is this pull request genuinely ready to land, or what is
 * blocking it?
 *
 * Two surfaces read this one function so the workbench never implies a pull
 * request is ready while a blocker is live: the queue state model, which shows
 * the authoritative state to a human or model, and the slay gate, which refuses
 * to merge or approve anything that is not fully ready. Both evaluate every
 * policy input — CI, reviews, holds, mergeability — before mutation.
 *
 * The bug this exists to prevent (review#461): after CI was repaired the
 * workbench read a pull request as green while a CHANGES_REQUESTED review and a
 * hold label were still live. Landing state must therefore consider reviews and
 * holds, not CI alone.
 */

import type { QueueItem } from "./github.ts";
import type { ManagedRepoPolicy, WorkbenchPolicy } from "./policy.ts";
import { managedPolicyFor } from "./policy.ts";

/**
 * A pull request is held when any of these labels is present. A hold is a hold
 * regardless of CI or reviews, so this is checked first and wins over every
 * other input.
 */
export const HOLD_LABELS = ["hold", "blocked"];

export type LandingState =
	| "ready-to-land"
	| "ci-pending"
	| "ci-failing"
	| "review-blocked"
	| "held"
	| "conflicts"
	| "unreviewed"
	| "incomplete";

/**
 * The labels that hold a pull request out of landing: the standard hold set,
 * plus anything a managed-repository policy denies. A managed policy may deny
 * additional labels, and those holds count too.
 */
function holdLabels(policy?: ManagedRepoPolicy): readonly string[] {
	const denied = policy?.deniedLabels ?? [];
	const union = new Set<string>(HOLD_LABELS);
	for (const label of denied) union.add(label);
	return [...union];
}

export function isHeld(item: QueueItem, policy?: ManagedRepoPolicy): boolean {
	const labels = holdLabels(policy);
	return item.labels.some((label) => labels.includes(label));
}

/** A short human reason for a non-ready state, for gates and the UI. */
export function landingReason(state: LandingState): string {
	switch (state) {
		case "ci-failing":
			return "CI is failure";
		case "ci-pending":
			return "CI is pending";
		case "review-blocked":
			return "has a changes_requested review";
		case "held":
			return "has a hold label";
		case "conflicts":
			return "has conflicts with the base";
		case "unreviewed":
			return "is awaiting approval";
		case "incomplete":
			return "is not a pull request";
		default:
			return "";
	}
}

/**
 * The one authoritative landing state for a pull request.
 *
 * A hold wins over everything. A requested-changes review blocks landing.
 * Failing or pending CI blocks it. A dirty merge blocks it. Anything without an
 * approval is not yet ready. Only a green, approved, clean, unheld pull
 * request is ready to land — nothing else implies ready with a blocker open.
 */
export function landingState(item: QueueItem, policy?: WorkbenchPolicy): LandingState {
	// A managed policy may deny more labels than the standard hold set, so look
	// up the per-repo policy for this pull request before checking holds.
	const repoPolicy = policy ? managedPolicyFor(item.repo, policy) : undefined;
	if (item.type !== "pr") return "incomplete";
	if (isHeld(item, repoPolicy)) return "held";
	if (item.reviewState === "changes_requested") return "review-blocked";
	if (item.ciStatus === "failure") return "ci-failing";
	if (item.ciStatus === "pending") return "ci-pending";
	if (item.mergeState === "dirty") return "conflicts";
	if (item.reviewState !== "approved") return "unreviewed";
	return "ready-to-land";
}

export function isLandingReady(item: QueueItem, policy?: WorkbenchPolicy): boolean {
	return landingState(item, policy) === "ready-to-land";
}
