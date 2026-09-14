/**
 * PR Reader widget model, LRU cache, content sanitizer, and navigation helper.
 * Issue #547: PR Reader in maintainer review mode.
 */

export interface PrComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface PrReview {
	author: string;
	state: string;
	body?: string;
}

export interface PrDetail {
	repo: string;
	number: number;
	headSha: string;
	title: string;
	body: string;
	author: string;
	comments: PrComment[];
	reviews: PrReview[];
}

export interface ReaderState {
	activePrKey?: string;
	scrollOffset: number;
	commentDrafts: Record<string, string>;
	mode: "reading" | "composing";
}

/**
 * Strips terminal ANSI escape sequences and script tags from untrusted remote markdown.
 */
export function sanitizeMarkdown(raw: string): string {
	if (!raw) {
		return "";
	}

	// 1. Strip ANSI escape sequences:
	// Matches ESC [ ... final byte or OSC ESC ] ... ESC \ or BEL
	const ansiRegex =
		/[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

	let cleaned = raw.replace(ansiRegex, "");

	// Also catch any standalone escape characters if left
	cleaned = cleaned.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");

	// 2. Strip <script...>...</script> tags and unclosed / self-closing <script...> tags
	// Case-insensitive, multiline/dotAll
	cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
	cleaned = cleaned.replace(/<script\b[^>]*\/?>/gi, "");

	return cleaned;
}

/**
 * LRU cache bounded to maxEntries for PR details.
 * Cache key: `${repo}#${prNumber}@${headSha}`.
 */
export class PrDetailCache {
	private readonly maxEntries: number;
	private readonly map = new Map<string, PrDetail>();

	constructor(maxEntries = 50) {
		this.maxEntries = maxEntries > 0 ? maxEntries : 50;
	}

	get(key: string): PrDetail | undefined {
		const entry = this.map.get(key);
		if (entry === undefined) {
			return undefined;
		}
		// Refresh LRU order: delete and re-insert
		this.map.delete(key);
		this.map.set(key, entry);
		return entry;
	}

	set(key: string, detail: PrDetail): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxEntries) {
			// Evict oldest item (first key in map iterator)
			const oldestKey = this.map.keys().next().value;
			if (oldestKey !== undefined) {
				this.map.delete(oldestKey);
			}
		}
		this.map.set(key, detail);
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	clear(): void {
		this.map.clear();
	}

	size(): number {
		return this.map.size;
	}
}

/**
 * Navigation helper across filtered PR keys.
 * Bounded or wrapped navigation across filtered PR keys.
 */
export function getNextPrKey(
	keys: string[],
	currentKey: string,
	direction: "next" | "prev",
): string {
	if (!keys || keys.length === 0) {
		return currentKey;
	}

	const currentIndex = keys.indexOf(currentKey);
	if (currentIndex === -1) {
		// If currentKey is not in keys list, return first item for next, last item for prev
		return direction === "next" ? keys[0] : keys[keys.length - 1];
	}

	if (direction === "next") {
		const nextIndex = (currentIndex + 1) % keys.length;
		return keys[nextIndex];
	} else {
		const prevIndex = (currentIndex - 1 + keys.length) % keys.length;
		return keys[prevIndex];
	}
}
