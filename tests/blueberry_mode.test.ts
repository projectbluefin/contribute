import assert from "node:assert/strict";
import test from "node:test";
import {
	BLUEBERRY_WELCOME_MESSAGE,
	checkBlueberryPermission,
	assertBlueberryActionAllowed,
	formatBlueberryAdvisoryReview,
	type BlueberryStatus,
} from "../image/extension/bluefin-review/blueberry.ts";
import { fetchCollaboratorPermission } from "../image/extension/bluefin-review/github.ts";
import { actionPrompt, type DashboardAction } from "../image/extension/bluefin-review/extension.ts";
import { ReviewMode } from "../image/extension/bluefin-review/mode.ts";
import { tmuxReviewStatusBar } from "../image/extension/bluefin-review/rail.ts";
import { PLAIN_PAINTER } from "../image/extension/bluefin-review/glyphs.ts";

test("checkBlueberryPermission identifies read and none permissions as blueberry", () => {
	assert.equal(checkBlueberryPermission("read"), true);
	assert.equal(checkBlueberryPermission("none"), true);
	assert.equal(checkBlueberryPermission("READ"), true);
	assert.equal(checkBlueberryPermission(" NONE "), true);

	assert.equal(checkBlueberryPermission("admin"), false);
	assert.equal(checkBlueberryPermission("write"), false);
	assert.equal(checkBlueberryPermission("ADMIN"), false);
	assert.equal(checkBlueberryPermission("WRITE"), false);
	assert.equal(checkBlueberryPermission("triage"), false);
	assert.equal(checkBlueberryPermission(""), false);
});

test("bluefin review implies blueberry based strictly on GitHub status, with no local bypass logic", async () => {
	// 1. Mock GitHub API responses for /repos/{owner}/{repo}/collaborators/{username}/permission
	const mockFetch = async (url: string | URL | Request) => {
		const urlStr = url.toString();
		if (urlStr.includes("/collaborators/alice/permission")) {
			// Alice has read permission -> Blueberry
			return new Response(JSON.stringify({ permission: "read", role_name: "read" }), { status: 200 });
		}
		if (urlStr.includes("/collaborators/bob/permission")) {
			// Bob has admin permission -> Maintainer
			return new Response(JSON.stringify({ permission: "admin", role_name: "admin" }), { status: 200 });
		}
		if (urlStr.includes("/collaborators/external_contributor/permission")) {
			// External user not in collaborator list -> 404 from GitHub
			return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		}
		return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
	};

	// Query Alice: read permission implies blueberry
	const alicePerm = await fetchCollaboratorPermission("projectbluefin/review", "alice", { fetchImpl: mockFetch as typeof fetch });
	assert.equal(alicePerm.isCollaborator, false);
	assert.equal(checkBlueberryPermission(alicePerm.permission ?? ""), true);

	// Query Bob: admin permission implies maintainer (NOT blueberry)
	const bobPerm = await fetchCollaboratorPermission("projectbluefin/review", "bob", { fetchImpl: mockFetch as typeof fetch });
	assert.equal(bobPerm.isCollaborator, true);
	assert.equal(checkBlueberryPermission(bobPerm.permission ?? ""), false);

	// Query external contributor: 404 maps to permission "none" -> implies blueberry
	const externalPerm = await fetchCollaboratorPermission("projectbluefin/review", "external_contributor", { fetchImpl: mockFetch as typeof fetch });
	assert.equal(externalPerm.permission, "none");
	assert.equal(checkBlueberryPermission(externalPerm.permission ?? ""), true);

	// Test mode state reflects GitHub status directly
	const mode = new ReviewMode({ org: "projectbluefin" });
	assert.equal(mode.isBlueberry, false, "starts in default mode");
	mode.setBlueberry(checkBlueberryPermission(alicePerm.permission ?? ""));
	assert.equal(mode.isBlueberry, true, "alice is Blueberry based on GitHub API response");

	const maintainerMode = new ReviewMode({ org: "projectbluefin" });
	maintainerMode.setBlueberry(checkBlueberryPermission(bobPerm.permission ?? ""));
	assert.equal(maintainerMode.isBlueberry, false, "bob is Maintainer based on GitHub API response");
});

test("blueberry can donate an advisory review to the project", () => {
	const item = {
		id: 101,
		type: "pr" as const,
		repo: "projectbluefin/review",
		title: "fix(landing): handle timeout safely",
		author: "contributor-jane",
		url: "https://github.com/projectbluefin/review/pull/101",
		updatedAt: Date.now(),
		draft: false,
		mergeState: "clean" as const,
		reviewState: "review_required" as const,
		labels: [],
	};

	const action: DashboardAction = { kind: "review", item };

	// 1. Generate prompt for Blueberry mode: donates advisory review
	const prompt = actionPrompt(action, undefined, { isBlueberry: true, model: "gemini-3.8-flash" });
	assert.ok(prompt !== undefined);
	assert.match(prompt, /donate your review to the project as an advisory submission/i);
	assert.match(prompt, /\[Blueberry Advisory Review \| Model: gemini-3.8-flash\]/);
	assert.match(prompt, /gh pr review 101 --repo projectbluefin\/review --comment -b/);
	assert.match(prompt, /Never approve, merge, or apply landing labels/);

	// 2. Format a real donated review comment body
	const reviewFindings = "doctrine: PASS\ncorrectness: PASS\nsimplicity: PASS\nVerified clean diff.";
	const donatedReviewBody = formatBlueberryAdvisoryReview(reviewFindings, "gemini-3.8-flash");

	assert.ok(donatedReviewBody.startsWith("[Blueberry Advisory Review | Model: gemini-3.8-flash]"));
	assert.match(donatedReviewBody, /doctrine: PASS/);
	assert.match(donatedReviewBody, /Verified clean diff\./);
});

test("blueberry mode UI renders Blueberry status badge in bottom-left rail", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.setBlueberry(true);

	const bar = tmuxReviewStatusBar(mode, PLAIN_PAINTER, 160, Date.now());
	assert.match(bar, /Blueberry/, "status bar displays Blueberry label");
	assert.doesNotMatch(bar, / review /, "status bar does not display maintainer 'review' label");
});

test("assertBlueberryActionAllowed blocks mutations for blueberries and allows for maintainers", () => {
	const blockedActions = ["approve", "merge", "land", "fix-and-land", "label"];
	for (const action of blockedActions) {
		const result = assertBlueberryActionAllowed(action, true);
		assert.equal(result.allowed, false, `Expected action '${action}' to be blocked for blueberry`);
		assert.match(result.reason ?? "", /restricted to maintainers/);

		const maintainerResult = assertBlueberryActionAllowed(action, false);
		assert.equal(maintainerResult.allowed, true, `Expected action '${action}' to be allowed for maintainer`);
	}
});

test("assertBlueberryActionAllowed permits read-only and advisory actions for blueberries", () => {
	const allowedActions = ["review", "advisory_comment", "inspect", "read", "status"];
	for (const action of allowedActions) {
		const result = assertBlueberryActionAllowed(action, true);
		assert.equal(result.allowed, true, `Expected action '${action}' to be allowed for blueberry`);
		assert.equal(result.reason, undefined);
	}
});

test("BLUEBERRY_WELCOME_MESSAGE matches the exact copy from Issue #548", () => {
	const expected =
		"Welcome! Your path to greatness awaits!\n\n" +
		"You need to be a maintainer to review and land code in Bluefin. To build that trust you can do reviews on open pull requests to the project automatically with this tool. This is valuable to maintainers because it provides more opinions on a submission. A pull request with a bunch of independent reviews from different models by different people around the world is very valuable!\n\n" +
		"Sit back and start reading! You can steer this thing, start reading and learning! Your worker and review contributions are measured as independent and related stats here:\n\n" +
		"https://docs.projectbluefin.io/leaderboards/";

	assert.equal(BLUEBERRY_WELCOME_MESSAGE, expected);
});

test("BlueberryStatus type can be constructed", () => {
	const status: BlueberryStatus = {
		isBlueberry: true,
		permission: "read",
		welcomeShown: false,
	};
	assert.equal(status.isBlueberry, true);
	assert.equal(status.permission, "read");
	assert.equal(status.welcomeShown, false);
});
