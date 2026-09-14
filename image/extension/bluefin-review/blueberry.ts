export interface BlueberryStatus {
	isBlueberry: boolean;
	permission: string;
	welcomeShown: boolean;
}

export const BLUEBERRY_WELCOME_MESSAGE =
	"Welcome! Your path to greatness awaits!\n\n" +
	"You need to be a maintainer to review and land code in Bluefin. To build that trust you can do reviews on open pull requests to the project automatically with this tool. This is valuable to maintainers because it provides more opinions on a submission. A pull request with a bunch of independent reviews from different models by different people around the world is very valuable!\n\n" +
	"Sit back and start reading! You can steer this thing, start reading and learning! Your worker and review contributions are measured as independent and related stats here:\n\n" +
	"https://docs.projectbluefin.io/leaderboards/";

export function checkBlueberryPermission(permission: string): boolean {
	const normalized = (permission ?? "").trim().toLowerCase();
	return normalized === "read" || normalized === "none";
}

const BLOCKED_ACTIONS: Record<string, true> = {
	approve: true,
	merge: true,
	land: true,
	"fix-and-land": true,
	label: true,
};

export function assertBlueberryActionAllowed(
	action: string,
	isBlueberry: boolean,
): { allowed: boolean; reason?: string } {
	const normalizedAction = (action ?? "").trim().toLowerCase();

	if (isBlueberry && BLOCKED_ACTIONS[normalizedAction]) {
		return {
			allowed: false,
			reason: `Action '${action}' is restricted to maintainers. Blueberry contributors can perform read-only reviews and advisory comments.`,
		};
	}

	return { allowed: true };
}

export function formatBlueberryAdvisoryReview(comment: string, model: string): string {
	return `[Blueberry Advisory Review | Model: ${model}]\n\n${comment}`;
}
