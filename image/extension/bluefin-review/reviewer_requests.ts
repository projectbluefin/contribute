export interface PrReview {
	author: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
	commitId: string;
	submittedAt: string;
}

export interface ReviewStatusResult {
	canLand: boolean;
	approvalsCount: number;
	requiredApprovals: number;
	reasons: string[];
}

/**
 * Evaluates whether a PR satisfies the two-review requirement before landing.
 *
 * Rules:
 * - Requires >= 2 distinct qualifying approvals.
 * - PR author's approval does not count.
 * - Dismissed reviews do not count.
 * - Approvals on stale commitId (different from currentHeadSha) do not count.
 * - Multiple approvals from the same author count as 1.
 */
export function evaluateTwoReviewRequirement(
	reviews: PrReview[],
	prAuthor: string,
	currentHeadSha: string,
): ReviewStatusResult {
	const requiredApprovals = 2;
	const qualifyingApprovingAuthors = new Set<string>();
	const reasons: string[] = [];

	// Map latest relevant state or inspect qualifying reviews
	// Note: reviews may have multiple entries per author.
	// For each author, we check if they have a qualifying approval on currentHeadSha.
	for (const review of reviews) {
		if (review.author === prAuthor) {
			continue;
		}
		if (review.state !== "APPROVED") {
			continue;
		}
		if (review.commitId !== currentHeadSha) {
			continue;
		}
		qualifyingApprovingAuthors.add(review.author);
	}

	const approvalsCount = qualifyingApprovingAuthors.size;
	const canLand = approvalsCount >= requiredApprovals;

	if (!canLand) {
		const needed = requiredApprovals - approvalsCount;
		reasons.push(
			`PR requires at least ${requiredApprovals} approvals on the latest commit (${currentHeadSha.slice(0, 7)}), but has ${approvalsCount}. Needs ${needed} more approval${needed === 1 ? "" : "s"}.`,
		);
	}

	return {
		canLand,
		approvalsCount,
		requiredApprovals,
		reasons,
	};
}

/**
 * Returns true if currentUserLogin is requested as a reviewer.
 */
export function calculatePersonalPriority(
	requestedReviewers: string[] | undefined,
	currentUserLogin: string,
): boolean {
	if (!requestedReviewers || requestedReviewers.length === 0) {
		return false;
	}
	return requestedReviewers.includes(currentUserLogin);
}

/**
 * Sorts items putting items where currentUserLogin is requested at the top,
 * preserving the relative order of items within each partition (stable sort).
 */
export function sortWithPersonalPriority<T extends { requestedReviewers?: string[] }>(
	items: T[],
	currentUserLogin: string,
): T[] {
	const prioritized: T[] = [];
	const rest: T[] = [];

	for (const item of items) {
		if (calculatePersonalPriority(item.requestedReviewers, currentUserLogin)) {
			prioritized.push(item);
		} else {
			rest.push(item);
		}
	}

	return [...prioritized, ...rest];
}
