import assert from "node:assert/strict";
import test from "node:test";

import {
	type PrReview,
	type ReviewStatusResult,
	evaluateTwoReviewRequirement,
	calculatePersonalPriority,
	sortWithPersonalPriority,
} from "../image/extension/bluefin-review/reviewer_requests.ts";

test("evaluateTwoReviewRequirement: 0 approvals -> blocked", () => {
	const reviews: PrReview[] = [];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 0);
	assert.equal(result.requiredApprovals, 2);
	assert.equal(result.reasons.length, 1);
	assert.match(result.reasons[0], /PR requires at least 2 approvals.*has 0/);
});

test("evaluateTwoReviewRequirement: 1 approval -> blocked", () => {
	const reviews: PrReview[] = [
		{
			author: "bob",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:00:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 1);
	assert.equal(result.requiredApprovals, 2);
	assert.equal(result.reasons.length, 1);
	assert.match(result.reasons[0], /PR requires at least 2 approvals.*has 1.*Needs 1 more approval\./);
});

test("evaluateTwoReviewRequirement: 2 distinct valid approvals on current head -> allowed", () => {
	const reviews: PrReview[] = [
		{
			author: "bob",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:00:00Z",
		},
		{
			author: "charlie",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:05:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, true);
	assert.equal(result.approvalsCount, 2);
	assert.equal(result.requiredApprovals, 2);
	assert.deepEqual(result.reasons, []);
});

test("evaluateTwoReviewRequirement: author approvals ignored", () => {
	const reviews: PrReview[] = [
		{
			author: "alice",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T09:00:00Z",
		},
		{
			author: "bob",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:00:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 1);
});

test("evaluateTwoReviewRequirement: stale head approvals ignored", () => {
	const reviews: PrReview[] = [
		{
			author: "bob",
			state: "APPROVED",
			commitId: "oldsha",
			submittedAt: "2026-09-13T10:00:00Z",
		},
		{
			author: "charlie",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:05:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 1);
});

test("evaluateTwoReviewRequirement: duplicate approvals from same reviewer deduplicated", () => {
	const reviews: PrReview[] = [
		{
			author: "bob",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:00:00Z",
		},
		{
			author: "bob",
			state: "APPROVED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:02:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 1);
});

test("evaluateTwoReviewRequirement: non-approval states ignored", () => {
	const reviews: PrReview[] = [
		{
			author: "bob",
			state: "CHANGES_REQUESTED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:00:00Z",
		},
		{
			author: "charlie",
			state: "COMMENTED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:05:00Z",
		},
		{
			author: "dave",
			state: "DISMISSED",
			commitId: "sha123",
			submittedAt: "2026-09-13T10:10:00Z",
		},
	];
	const result = evaluateTwoReviewRequirement(reviews, "alice", "sha123");

	assert.equal(result.canLand, false);
	assert.equal(result.approvalsCount, 0);
});

test("calculatePersonalPriority: matches user or returns false", () => {
	assert.equal(calculatePersonalPriority(["alice", "bob"], "alice"), true);
	assert.equal(calculatePersonalPriority(["alice", "bob"], "charlie"), false);
	assert.equal(calculatePersonalPriority(undefined, "alice"), false);
	assert.equal(calculatePersonalPriority([], "alice"), false);
});

test("sortWithPersonalPriority: prioritizes items requested for current user while preserving relative order", () => {
	interface Item {
		id: number;
		requestedReviewers?: string[];
	}

	const items: Item[] = [
		{ id: 1, requestedReviewers: ["bob"] },
		{ id: 2, requestedReviewers: ["alice", "bob"] },
		{ id: 3, requestedReviewers: [] },
		{ id: 4, requestedReviewers: ["bob", "alice"] },
		{ id: 5 },
		{ id: 6, requestedReviewers: ["charlie"] },
	];

	const sorted = sortWithPersonalPriority(items, "alice");

	assert.deepEqual(
		sorted.map((item) => item.id),
		[2, 4, 1, 3, 5, 6],
	);
});
