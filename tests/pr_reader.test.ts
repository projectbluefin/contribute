/**
 * Unit tests for PR Reader widget model, LRU cache, content sanitizer,
 * draft isolation, and navigation helper.
 *
 * Run with:
 *   node --test tests/pr_reader.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	PrDetailCache,
	getNextPrKey,
	sanitizeMarkdown,
	type PrDetail,
	type ReaderState,
} from "../image/extension/bluefin-review/reader.ts";

test("sanitizeMarkdown strips ANSI escape codes", () => {
	const rawWithAnsi = "\u001B[31mRed Alert\u001B[0m and \u001B[1;32mBold Green\u001B[0m text";
	const sanitized = sanitizeMarkdown(rawWithAnsi);
	assert.equal(sanitized, "Red Alert and Bold Green text");
	assert.equal(sanitized.includes("\u001B"), false);
});

test("sanitizeMarkdown strips script tags and contents", () => {
	const rawWithScript = "Hello world\n<script>alert('xss');</script>\nGoodbye <script type=\"text/javascript\">console.log(1);</script>!";
	const sanitized = sanitizeMarkdown(rawWithScript);
	assert.equal(sanitized.includes("<script"), false);
	assert.equal(sanitized.includes("alert"), false);
	assert.equal(sanitized.includes("console.log"), false);
	assert.equal(sanitized.trim(), "Hello world\n\nGoodbye !");
});

test("sanitizeMarkdown handles self-closing or unclosed script tags", () => {
	const raw = 'Before <script src="evil.js"/> middle <script src="evil2.js"> after';
	const sanitized = sanitizeMarkdown(raw);
	assert.equal(sanitized.includes("<script"), false);
	assert.equal(sanitized.includes("evil"), false);
});

test("sanitizeMarkdown returns empty string for empty input", () => {
	assert.equal(sanitizeMarkdown(""), "");
});

test("PrDetailCache stores and retrieves by repo#number@headSha key", () => {
	const cache = new PrDetailCache(3);
	const detail1: PrDetail = {
		repo: "projectbluefin/review",
		number: 547,
		headSha: "abc1234",
		title: "Add PR Reader",
		body: "Detailed description",
		author: "jorge",
		comments: [
			{ author: "reviewer1", body: "LGTM", createdAt: "2026-09-13T10:00:00Z" },
		],
		reviews: [
			{ author: "reviewer1", state: "APPROVED" },
		],
	};

	const key1 = `${detail1.repo}#${detail1.number}@${detail1.headSha}`;
	cache.set(key1, detail1);

	assert.equal(cache.has(key1), true);
	assert.equal(cache.size(), 1);
	const retrieved = cache.get(key1);
	assert.deepEqual(retrieved, detail1);
});

test("PrDetailCache evicts LRU entry past capacity", () => {
	const cache = new PrDetailCache(2);

	const createDetail = (num: number, sha: string): PrDetail => ({
		repo: "test/repo",
		number: num,
		headSha: sha,
		title: `PR ${num}`,
		body: `Body ${num}`,
		author: "alice",
		comments: [],
		reviews: [],
	});

	const key1 = "test/repo#1@sha1";
	const key2 = "test/repo#2@sha2";
	const key3 = "test/repo#3@sha3";

	cache.set(key1, createDetail(1, "sha1"));
	cache.set(key2, createDetail(2, "sha2"));
	assert.equal(cache.size(), 2);

	// Access key1 to make key2 the least recently used
	assert.ok(cache.get(key1));

	// Add key3 -> key2 should be evicted
	cache.set(key3, createDetail(3, "sha3"));
	assert.equal(cache.size(), 2);
	assert.equal(cache.has(key2), false, "key2 should be evicted");
	assert.equal(cache.has(key1), true, "key1 should remain");
	assert.equal(cache.has(key3), true, "key3 should remain");
});

test("PrDetailCache invalidates on headSha change", () => {
	const cache = new PrDetailCache(5);
	const detailV1: PrDetail = {
		repo: "test/repo",
		number: 10,
		headSha: "commit1",
		title: "Feature",
		body: "Initial PR description",
		author: "bob",
		comments: [],
		reviews: [],
	};

	const keyV1 = `${detailV1.repo}#${detailV1.number}@${detailV1.headSha}`;
	cache.set(keyV1, detailV1);

	const keyV2 = `${detailV1.repo}#${detailV1.number}@commit2`;
	assert.equal(cache.has(keyV2), false, "New headSha should be a cache miss");
	assert.equal(cache.get(keyV2), undefined);

	// Now cache the new headSha
	const detailV2: PrDetail = { ...detailV1, headSha: "commit2", body: "Updated PR description" };
	cache.set(keyV2, detailV2);
	assert.equal(cache.has(keyV2), true);
	assert.equal(cache.get(keyV2)?.body, "Updated PR description");
});

test("PrDetailCache clear() wipes all entries", () => {
	const cache = new PrDetailCache(5);
	cache.set("test#1@sha", {
		repo: "test",
		number: 1,
		headSha: "sha",
		title: "T",
		body: "B",
		author: "A",
		comments: [],
		reviews: [],
	});
	assert.equal(cache.size(), 1);
	cache.clear();
	assert.equal(cache.size(), 0);
	assert.equal(cache.has("test#1@sha"), false);
});

test("ReaderState isolates draft comments per PR key", () => {
	const state: ReaderState = {
		scrollOffset: 0,
		commentDrafts: {},
		mode: "reading",
	};

	const prKey1 = "projectbluefin/review#547@shaA";
	const prKey2 = "projectbluefin/review#548@shaB";

	state.commentDrafts[prKey1] = "Draft comment for PR 547";
	state.commentDrafts[prKey2] = "Draft comment for PR 548";

	assert.equal(state.commentDrafts[prKey1], "Draft comment for PR 547");
	assert.equal(state.commentDrafts[prKey2], "Draft comment for PR 548");

	// Updating draft for PR 547 does not mutate PR 548
	state.commentDrafts[prKey1] += " - edit";
	assert.equal(state.commentDrafts[prKey1], "Draft comment for PR 547 - edit");
	assert.equal(state.commentDrafts[prKey2], "Draft comment for PR 548");
});

test("getNextPrKey navigates next and prev with wrapping", () => {
	const keys = ["repo#1", "repo#2", "repo#3"];

	// Next
	assert.equal(getNextPrKey(keys, "repo#1", "next"), "repo#2");
	assert.equal(getNextPrKey(keys, "repo#2", "next"), "repo#3");
	assert.equal(getNextPrKey(keys, "repo#3", "next"), "repo#1"); // wraps

	// Prev
	assert.equal(getNextPrKey(keys, "repo#3", "prev"), "repo#2");
	assert.equal(getNextPrKey(keys, "repo#2", "prev"), "repo#1");
	assert.equal(getNextPrKey(keys, "repo#1", "prev"), "repo#3"); // wraps
});

test("getNextPrKey handles missing or edge currentKey", () => {
	const keys = ["repo#10", "repo#20"];

	// currentKey not present
	assert.equal(getNextPrKey(keys, "unknown", "next"), "repo#10");
	assert.equal(getNextPrKey(keys, "unknown", "prev"), "repo#20");

	// empty keys
	assert.equal(getNextPrKey([], "repo#10", "next"), "repo#10");
	assert.equal(getNextPrKey([], "repo#10", "prev"), "repo#10");
});
