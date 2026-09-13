/**
 * The dashboard: a focusable, full-width Dagger-style view of the review queue
 * and the pipeline behind the selected item.
 *
 * Left pane is the queue, right pane is the trace. The trace pane is the same
 * renderer that draws the rail, so a step looks the same everywhere. Keys follow
 * Dagger's TUI: `j/k` move, `h/l` collapse and expand, `/` filters, `?` explains,
 * and the action keys act on whatever the cursor is on.
 *
 * The component owns no policy: it resolves with a `DashboardAction` and lets the
 * extension decide what that means.
 */

import { GLYPH, SPINNER_TICK_MS, type Painter, formatDuration, statusIcon, statusRole } from "./glyphs.ts";
import type { QueueItem } from "./github.ts";
import { type KeyMatcher, canonicalKey, rawKeyMatcher } from "./keys.ts";
import { type ReviewMode, ciGlyph } from "./mode.ts";
import { type RailKey, keymapBar, orderSourceLabel, priorityChip, tmuxReviewStatusBar } from "./rail.ts";
import { type RenderedRow, type Span, defaultExpanded, findSpan, hasChildren, renderSpanTree, visibleSpanIds } from "./trace.ts";
import { fitToWidth, truncateToWidth, visibleWidth } from "./width.ts";
import { BLUEFIN_RAPTOR_BANNER, renderRaptorGlyph } from "./mascot.ts";
export type DashboardAction =
	| { kind: "close" }
	| { kind: "review"; item: QueueItem; items?: QueueItem[] }
	| { kind: "diff"; item: QueueItem; items?: QueueItem[] }
	| { kind: "docs"; item: QueueItem; items?: QueueItem[] }
	| { kind: "approve"; item: QueueItem; items?: QueueItem[] }
	| { kind: "fix"; item: QueueItem; items?: QueueItem[] }
	| { kind: "slay"; item: QueueItem; items?: QueueItem[] }
	| { kind: "reference"; item: QueueItem; items?: QueueItem[] }
	| { kind: "scope" }
	| { kind: "snapshot" }
	| { kind: "leaderboard" };

export const DASHBOARD_KEYS: readonly RailKey[] = [
	{ chord: "s", label: "autoslay" },
	{ chord: "r/enter", label: "review" },
	{ chord: "a", label: "approve" },
	{ chord: "space", label: "select" },
	{ chord: "A", label: "all" },
	{ chord: "x", label: "clear" },
	{ chord: "j/k", label: "move" },
	{ chord: "tab", label: "pane" },
	{ chord: "h/l", label: "fold" },
	{ chord: "i", label: "prs/issues" },
	{ chord: "H", label: "hive" },
	{ chord: "L", label: "stage" },
	{ chord: "d", label: "diff" },
	{ chord: "D", label: "docs" },
	{ chord: "f", label: "fix" },
	{ chord: "y", label: "cite" },
	{ chord: "*", label: "leaders" },
	{ chord: "o", label: "repo" },
	{ chord: "/", label: "filter" },
	{ chord: "q", label: "close" },
];

const HELP: readonly string[] = [
	"Bluefin review dashboard",
	"",
	"  space            toggle selection on the highlighted item",
	"  x                clear all selections",
	"  A                select every row the filters left on screen (max 25)",
	"  tab              switch between queue and trace",
	"  h / l, ← / →     collapse or expand a trace span",
	"  g / G            jump to first or last row",
	"  i                toggle pull requests and issues",
	"  H                toggle hive-only filter (default: on)",
	"  L                step through Hive's triage stages, then back to all",
	"  o                review another repository (owner/repo)",
	"  u                refetch the queue now",
	"  /                search/filter by title, repo, author, label, number",
	"                   (in search: type to live-filter, tab/space to select, A to select all)",
	"  enter / r        review the selected pull request",
	"  d                inspect its bounded diff",
	"  D                update documentation enforcing agentic docs system",
	"  a                verify checks, approve, squash merge",
	"  f                fix the findings reported for it",
	"  s                slay: on a pull request review, patch, verify, land;",
	"                   on an issue implement it and open a pull request",
	"  y                cite the selection in the prompt",
	"  b                build a container snapshot",
	"  *                hive weekly leaderboard (top 25 contributors)",
	"  ?                close this help",
	"  q, esc           close the dashboard",
	"",
	"Mouse / Click parity:",
	"  Click any queue row to select it; click the checkbox to toggle it.",
	"  Click panes to focus; click trace spans to collapse/expand.",
	"  Scroll with the mouse wheel to navigate queue or trace.",
	"  Click any visible keymap action to trigger it.",
	"",
	"Trace spans come from the appliance's own durable state under",
	"bluefin-review/: run-state, review batches, landings, receipts.",
	"Live turn spans come from this session's tool executions.",
	"",
	"Order comes from Hive when a hub is configured — its queue, its",
	"positions, never recomputed here. Without a hub the queue is",
	"categorized locally: ready, findings, blocked, waiting, deps,",
	"draft, stale. The header always names which one ran.",
];

interface TuiLike {
	requestRender(): void;
}

export type Pane = "queue" | "trace";

export interface MouseEvent {
	button: number;
	col: number; // 0-based column
	row: number; // 0-based row
	release: boolean;
	wheel?: -1 | 1;
}

/**
 * Parses terminal mouse reporting sequences into structured MouseEvent objects.
 * Supports SGR 1006 (\x1b[<b;x;y[Mm]), X10/X11 (\x1b[MCbCxCy), URXVT (\x1b[b;x;yM),
 * and direct programmatic/pilot strings (click:col,row, wheel:up/down, or JSON).
 */
export function parseMouseEvent(data: string): MouseEvent | undefined {
	// SGR format: \x1b[<button;x;y[Mm]
	const sgrMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgrMatch) {
		const button = Number.parseInt(sgrMatch[1]!, 10);
		const col = Number.parseInt(sgrMatch[2]!, 10) - 1;
		const row = Number.parseInt(sgrMatch[3]!, 10) - 1;
		const release = sgrMatch[4] === "m";
		if ((button & 64) !== 0 || button === 64 || button === 65) {
			const dir = (button & 1) === 0 && button !== 65 ? -1 : 1;
			return { button, col: Math.max(0, col), row: Math.max(0, row), release: false, wheel: dir };
		}
		return { button, col: Math.max(0, col), row: Math.max(0, row), release };
	}

	// Normal X10/X11 format: \x1b[M Cb Cx Cy
	if (data.startsWith("\x1b[M") && data.length === 6) {
		const cb = data.charCodeAt(3) - 32;
		const cx = data.charCodeAt(4) - 32 - 1;
		const cy = data.charCodeAt(5) - 32 - 1;
		const release = (cb & 3) === 3;
		if ((cb & 64) !== 0 || cb === 64 || cb === 65) {
			const dir = (cb & 1) === 0 && cb !== 65 ? -1 : 1;
			return { button: cb, col: Math.max(0, cx), row: Math.max(0, cy), release: false, wheel: dir };
		}
		return { button: cb, col: Math.max(0, cx), row: Math.max(0, cy), release };
	}

	// URXVT format: \x1b[button;x;yM
	const urxvtMatch = /^\x1b\[(\d+);(\d+);(\d+)M$/.exec(data);
	if (urxvtMatch) {
		const rawBtn = Number.parseInt(urxvtMatch[1]!, 10);
		const button = rawBtn >= 32 ? rawBtn - 32 : rawBtn;
		const col = Number.parseInt(urxvtMatch[2]!, 10) - 1;
		const row = Number.parseInt(urxvtMatch[3]!, 10) - 1;
		if ((button & 64) !== 0 || button === 64 || button === 65) {
			const dir = (button & 1) === 0 && button !== 65 ? -1 : 1;
			return { button, col: Math.max(0, col), row: Math.max(0, row), release: false, wheel: dir };
		}
		return { button, col: Math.max(0, col), row: Math.max(0, row), release: false };
	}

	// Direct text commands: "click(x, y)", "click:x,y", "mouse:click:x,y"
	const directClick = /^(?:mouse:)?click(?:\((\d+),\s*(\d+)\)|:(\d+)[,:](\d+))$/.exec(data);
	if (directClick) {
		const col = Number.parseInt(directClick[1] ?? directClick[3]!, 10);
		const row = Number.parseInt(directClick[2] ?? directClick[4]!, 10);
		return { button: 0, col: Math.max(0, col), row: Math.max(0, row), release: false };
	}

	// Wheel text commands: "wheel:up", "wheel:down", etc.
	const directWheel = /^(?:mouse:)?wheel:(up|down)(?::(\d+)[,:](\d+))?$/.exec(data);
	if (directWheel) {
		const dir = directWheel[1] === "up" ? -1 : 1;
		const col = directWheel[2] ? Number.parseInt(directWheel[2], 10) : 0;
		const row = directWheel[3] ? Number.parseInt(directWheel[3], 10) : 0;
		return { button: dir === -1 ? 64 : 65, col: Math.max(0, col), row: Math.max(0, row), release: false, wheel: dir };
	}

	// JSON-formatted mouse events
	if (data.startsWith("{") && data.endsWith("}")) {
		try {
			const obj = JSON.parse(data) as Record<string, unknown>;
			if (obj.type === "click" || obj.event === "click") {
				return {
					button: typeof obj.button === "number" ? obj.button : 0,
					col: Math.max(0, typeof obj.col === "number" ? obj.col : (typeof obj.x === "number" ? obj.x : 0)),
					row: Math.max(0, typeof obj.row === "number" ? obj.row : (typeof obj.y === "number" ? obj.y : 0)),
					release: obj.release === true,
				};
			}
			if (obj.type === "wheel" || obj.event === "wheel") {
				const dir = typeof obj.direction === "number" ? (obj.direction < 0 ? -1 : 1) : -1;
				return {
					button: dir === -1 ? 64 : 65,
					col: Math.max(0, typeof obj.col === "number" ? obj.col : (typeof obj.x === "number" ? obj.x : 0)),
					row: Math.max(0, typeof obj.row === "number" ? obj.row : (typeof obj.y === "number" ? obj.y : 0)),
					release: false,
					wheel: dir,
				};
			}
		} catch {}
	}

	return undefined;
}

/** Minimum width before the panes stack instead of sitting side by side. */
const SPLIT_MIN_WIDTH = 96;

export class ReviewDashboard {
	/** Set by the TUI when focus changes (`Focusable`). */
	focused = true;

	private pane: Pane = "queue";
	private traceCursor = 0;
	private queueScroll = 0;
	private traceScroll = 0;
	private frame = 0;
	private showHelp = false;
	private filtering = false;
	private filterDraft = "";
	private expansion = new Map<string, boolean>();
	private stopTick: (() => void) | undefined;
	private lastWidth = 120;
	private queueRowItems: (number | "divider")[] = [];
	private traceRowSpans: (string | "hive" | undefined)[] = [];

	private readonly tui: TuiLike;
	private readonly painter: Painter;
	private readonly mode: ReviewMode;
	private readonly done: (action: DashboardAction) => void;
	private readonly onRefresh: () => void;
	private readonly rows: number;
	private readonly matchKey: KeyMatcher;

	constructor(
		tui: TuiLike,
		painter: Painter,
		mode: ReviewMode,
		done: (action: DashboardAction) => void,
		onRefresh: () => void,
		rows = 22,
		matchKey: KeyMatcher = rawKeyMatcher,
	) {
		this.tui = tui;
		this.painter = painter;
		this.mode = mode;
		this.done = done;
		this.onRefresh = onRefresh;
		this.rows = rows;
		this.matchKey = matchKey;
		this.enableMouse();
		const handle = setInterval(() => {
			try {
				this.frame += 1;
				this.mode.refreshState();
				this.tui.requestRender();
			} catch {
				// Never let a repaint tick escape: an uncaught throw here ends the session.
			}
		}, SPINNER_TICK_MS * 2);
		(handle as { unref?(): void }).unref?.();
		this.stopTick = () => clearInterval(handle);
	}

	get activePane(): Pane {
		return this.pane;
	}

	get currentPane(): Pane {
		return this.pane;
	}

	private enableMouse(): void {
		if (process.stdout?.isTTY) {
			try {
				process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
			} catch {
				// Ignore write failures in restricted environments
			}
		}
	}

	private disableMouse(): void {
		if (process.stdout?.isTTY) {
			try {
				process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
			} catch {
				// Ignore write failures in restricted environments
			}
		}
	}

	// ---- trace helpers -------------------------------------------------------

	private traceRoots(now: number): Span[] {
		return [...this.mode.pipelineSpans(now), ...this.mode.session.roots()];
	}

	private traceIds(now: number): string[] {
		return visibleSpanIds(this.traceRoots(now), this.expansion);
	}

	private toggleSpan(open: boolean): void {
		const ids = this.traceIds(Date.now());
		const id = ids[this.traceCursor];
		if (!id) return;
		const span = findSpan(this.traceRoots(Date.now()), id);
		if (!span || !hasChildren(span)) return;
		this.expansion.set(id, open);
	}

	// ---- input ---------------------------------------------------------------

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.wheel !== undefined) {
				this.handleWheel(mouse.wheel, mouse.col, mouse.row);
				return;
			}
			if (!mouse.release && (mouse.button & 3) === 0 && (mouse.button & 32) === 0) {
				this.handleClick(mouse.col, mouse.row, mouse.button);
				return;
			}
			return;
		}

		const key = canonicalKey(data, this.matchKey);
		if (this.filtering) {
			this.handleFilterInput(key, data);
			return;
		}

		this.executeKey(key);
	}

	handleClick(col: number, row: number, _button = 0): void {
		if (this.showHelp) {
			this.showHelp = false;
			this.tui.requestRender();
			return;
		}

		const width = this.lastWidth || 120;
		const bodyHeight = Math.max(4, this.rows - 4);
		const isSplit = width >= SPLIT_MIN_WIDTH;
		const leftWidth = isSplit ? Math.floor((width - 3) / 2) : width;
		const rightWidth = isSplit ? width - leftWidth - 3 : width;

		// 1. Header row
		if (row === 0) {
			this.handleHeaderClick(col, width);
			return;
		}

		// 2. Border row
		if (row === 1) {
			return;
		}

		// 3. Panes (Body)
		if (row >= 2 && row < 2 + bodyHeight) {
			const bodyRow = row - 2;
			if (isSplit) {
				if (col < leftWidth + 1) {
					this.handleQueuePaneClick(col, bodyRow, leftWidth, bodyHeight);
				} else {
					this.handleTracePaneClick(col - (leftWidth + 3), bodyRow, rightWidth, bodyHeight);
				}
			} else {
				const queueHeight = Math.max(3, Math.floor((bodyHeight - 2) / 2));
				if (bodyRow === 0) {
					this.pane = "queue";
					this.tui.requestRender();
				} else if (bodyRow <= queueHeight) {
					this.handleQueuePaneClick(col, bodyRow, width, queueHeight + 1);
				} else if (bodyRow === queueHeight + 1) {
					this.pane = "trace";
					this.tui.requestRender();
				} else {
					this.handleTracePaneClick(col, bodyRow - (queueHeight + 1), width, bodyHeight - queueHeight - 1);
				}
			}
			return;
		}

		// 4. Filter / Search line (if present)
		const hasFilterLine = this.filtering || Boolean(this.mode.filter);
		const filterRow = 2 + bodyHeight;
		if (hasFilterLine && row === filterRow) {
			this.handleFilterLineClick(col);
			return;
		}

		// 5. Keymap bar
		const keymapRow = filterRow + (hasFilterLine ? 1 : 0);
		if (row === keymapRow) {
			this.handleKeymapClick(col, width);
			return;
		}

		// 6. Status bar
		const statusRow = keymapRow + 1;
		if (row === statusRow) {
			this.handleStatusBarClick(col, width);
			return;
		}
	}

	handleWheel(direction: -1 | 1, col?: number, _row?: number): void {
		const width = this.lastWidth || 120;
		const isSplit = width >= SPLIT_MIN_WIDTH;
		const leftWidth = isSplit ? Math.floor((width - 3) / 2) : width;

		if (col !== undefined && isSplit) {
			if (col < leftWidth + 1) {
				this.pane = "queue";
			} else {
				this.pane = "trace";
			}
		}
		this.move(direction);
		this.tui.requestRender();
	}

	private handleHeaderClick(col: number, width: number): void {
		if (col <= 16) {
			this.showHelp = !this.showHelp;
			this.tui.requestRender();
			return;
		}
		if (col >= 18 && col <= 36) {
			this.mode.toggleMode();
			this.onRefresh();
			this.tui.requestRender();
			return;
		}
		if (col > 36 && col < width - 20) {
			if (this.mode.hiveLevel !== undefined) {
				this.mode.cycleHiveLevel();
			} else {
				this.mode.toggleHiveOnly();
			}
			this.tui.requestRender();
			return;
		}
		if (col >= width - 20) {
			this.onRefresh();
		}
	}

	private handleQueuePaneClick(col: number, bodyRow: number, _width: number, _height: number): void {
		this.pane = "queue";
		if (bodyRow === 0) {
			this.tui.requestRender();
			return;
		}
		const queueOffset = bodyRow - 1;
		const itemOrDivider = this.queueRowItems[queueOffset];
		if (itemOrDivider === "divider") {
			this.tui.requestRender();
			return;
		}
		if (typeof itemOrDivider === "number") {
			const itemIndex = itemOrDivider;
			if (col >= 1 && col <= 3) {
				this.mode.cursor = itemIndex;
				this.mode.toggleSelected();
			} else {
				this.mode.cursor = itemIndex;
				this.traceCursor = 0;
			}
			this.tui.requestRender();
			return;
		}

		// Fallback when rendered map is not populated yet
		const items = this.activeItems();
		if (items.length === 0) {
			this.tui.requestRender();
			return;
		}
		const itemIndex = this.queueScroll + queueOffset;
		if (itemIndex >= 0 && itemIndex < items.length) {
			if (col >= 1 && col <= 3) {
				this.mode.cursor = itemIndex;
				this.mode.toggleSelected();
			} else {
				this.mode.cursor = itemIndex;
				this.traceCursor = 0;
			}
			this.tui.requestRender();
		}
	}

	private handleTracePaneClick(_col: number, bodyRow: number, width: number, height: number): void {
		this.pane = "trace";
		if (bodyRow === 0) {
			this.tui.requestRender();
			return;
		}
		const traceOffset = bodyRow - 1;
		const spanId = this.traceRowSpans[traceOffset];
		if (spanId === "hive") {
			this.tui.requestRender();
			return;
		}
		if (typeof spanId === "string") {
			const ids = this.traceIds(Date.now());
			const cursorIdx = ids.indexOf(spanId);
			if (cursorIdx >= 0) {
				this.traceCursor = cursorIdx;
			}
			const roots = this.traceRoots(Date.now());
			const span = findSpan(roots, spanId);
			if (span && hasChildren(span)) {
				const current = this.expansion.get(span.id) ?? defaultExpanded(span);
				this.expansion.set(span.id, !current);
			}
			this.tui.requestRender();
			return;
		}

		// Fallback when rendered map is not populated yet
		const hive = this.hiveRows(width);
		if (traceOffset < hive.length) {
			this.tui.requestRender();
			return;
		}
		const spanRowIndex = traceOffset - hive.length;
		const roots = this.traceRoots(Date.now());
		const rendered = renderSpanTree(roots, {
			painter: this.painter,
			width,
			now: Date.now(),
			frame: this.frame,
			expansion: this.expansion,
			focusedId: undefined,
			maxLogLines: Math.max(3, Math.floor((height - 1 - hive.length) / 3)),
		});
		const targetRow = rendered[this.traceScroll + spanRowIndex];
		if (targetRow && targetRow.kind === "span") {
			const ids = this.traceIds(Date.now());
			const cursorIdx = ids.indexOf(targetRow.spanId);
			if (cursorIdx >= 0) {
				this.traceCursor = cursorIdx;
			}
			const span = findSpan(roots, targetRow.spanId);
			if (span && hasChildren(span)) {
				const current = this.expansion.get(span.id) ?? defaultExpanded(span);
				this.expansion.set(span.id, !current);
			}
		}
		this.tui.requestRender();
	}

	private handleFilterLineClick(col: number): void {
		if (this.filtering) {
			if (col > 70) {
				this.filtering = false;
				this.tui.requestRender();
				return;
			}
			if (col > 55) {
				this.filtering = false;
				this.mode.setFilter(this.filterDraft.trim());
				this.queueScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (col > 40) {
				this.mode.selectAllVisible();
				this.tui.requestRender();
				return;
			}
			this.toggleSelection();
			this.tui.requestRender();
		} else if (this.mode.filter) {
			if (col > 50) {
				this.mode.setFilter("");
				this.queueScroll = 0;
			} else {
				this.filtering = true;
				this.filterDraft = this.mode.filter;
			}
			this.tui.requestRender();
		}
	}

	private handleKeymapClick(col: number, _width: number): void {
		let currentOffset = 3;
		for (const key of DASHBOARD_KEYS) {
			const chordWidth = visibleWidth(key.chord);
			const labelWidth = visibleWidth(key.label);
			const itemWidth = chordWidth + 1 + labelWidth;
			const startCol = currentOffset;
			const endCol = currentOffset + itemWidth;
			const nextOffset = endCol + 3;

			if (col >= startCol && col < nextOffset) {
				this.triggerChordAction(key.chord, col, startCol, chordWidth);
				return;
			}
			currentOffset = nextOffset;
		}
	}

	private triggerChordAction(chord: string, col: number, startCol: number, chordWidth: number): void {
		switch (chord) {
			case "s":
				this.executeKey("s");
				break;
			case "r/enter":
				this.executeKey("r");
				break;
			case "a":
				this.executeKey("a");
				break;
			case "space":
				this.executeKey("space");
				break;
			case "A":
				this.executeKey("A");
				break;
			case "x":
				this.executeKey("x");
				break;
			case "j/k":
				if (col < startCol + Math.floor(chordWidth / 2)) {
					this.executeKey("k");
				} else {
					this.executeKey("j");
				}
				break;
			case "tab":
				this.executeKey("tab");
				break;
			case "h/l":
				if (col < startCol + Math.floor(chordWidth / 2)) {
					this.executeKey("h");
				} else {
					this.executeKey("l");
				}
				break;
			case "i":
				this.executeKey("i");
				break;
			case "H":
				this.executeKey("H");
				break;
			case "L":
				this.executeKey("L");
				break;
			case "d":
				this.executeKey("d");
				break;
			case "D":
				this.executeKey("D");
				break;
			case "f":
				this.executeKey("f");
				break;
			case "y":
				this.executeKey("y");
				break;
			case "*":
				this.executeKey("*");
				break;
			case "o":
				this.executeKey("o");
				break;
			case "/":
				this.executeKey("/");
				break;
			case "q":
				this.executeKey("q");
				break;
			default:
				break;
		}
	}

	private handleStatusBarClick(col: number, _width: number): void {
		if (col < 30) {
			this.mode.toggleHiveOnly();
			this.tui.requestRender();
			return;
		}
		if (col < 55) {
			const item = this.mode.selected();
			if (item) {
				this.executeKey("r");
			}
			return;
		}
		this.mode.toggleMode();
		this.onRefresh();
		this.tui.requestRender();
	}

	private executeKey(key: string): void {
		switch (key) {
			case "escape":
			case "q":
				this.done({ kind: "close" });
				return;
			case "?":
				this.showHelp = this.showHelp === false;
				this.tui.requestRender();
				return;
			case "tab":
				this.pane = this.pane === "queue" ? "trace" : "queue";
				this.tui.requestRender();
				return;
			case "/":
				this.filtering = true;
				this.filterDraft = this.mode.filter;
				this.tui.requestRender();
				return;
			case " ":
			case "space":
				this.toggleSelection();
				return;
			case "A":
				this.mode.selectAllVisible();
				this.tui.requestRender();
				return;
			case "x":
				this.mode.clearSelected();
				this.tui.requestRender();
				return;
			case "j":
			case "down":
				this.move(1);
				return;
			case "k":
			case "up":
				this.move(-1);
				return;
			case "g":
				this.jump(0);
				return;
			case "G":
				this.jump(Number.MAX_SAFE_INTEGER);
				return;
			case "h":
			case "left":
				if (this.pane === "trace") this.toggleSpan(false);
				else this.pane = "queue";
				this.tui.requestRender();
				return;
			case "l":
			case "right":
				if (this.pane === "trace") this.toggleSpan(true);
				else this.pane = "trace";
				this.tui.requestRender();
				return;
			case "i":
				this.mode.toggleMode();
				this.onRefresh();
				this.tui.requestRender();
				return;
			case "H":
				this.mode.toggleHiveOnly();
				this.tui.requestRender();
				return;
			case "L":
				this.mode.cycleHiveLevel();
				this.tui.requestRender();
				return;
			case "u":
				this.onRefresh();
				return;
			case "o":
				this.done({ kind: "scope" });
				return;
			case "b":
				this.done({ kind: "snapshot" });
				return;
			case "*":
				this.done({ kind: "leaderboard" });
				return;
			default:
				break;
		}

		const activeItem = this.mode.selected();
		if (!activeItem) return;
		const chosenItems = this.chosenItems();
		const items = chosenItems.length > 0 ? chosenItems : undefined;
		const item = items ? items[0]! : activeItem;
		switch (key) {
			case "r":
			case "return":
			case "enter":
				this.done({ kind: "review", item, items });
				return;
			case "d":
				this.done({ kind: "diff", item, items });
				return;
			case "D":
				this.done({ kind: "docs", item, items });
				return;
			case "a":
				this.done({ kind: "approve", item, items });
				return;
			case "f":
				this.done({ kind: "fix", item, items });
				return;
			case "s": {
				const slayable = this.mode.slayableItems();
				const batch = chosenItems.length > 0 ? chosenItems : (slayable.length > 0 ? slayable.slice(0, 7) : undefined);
				const targetItem = batch && batch.length > 0 ? batch[0]! : activeItem;
				this.done({ kind: "slay", item: targetItem, items: batch && batch.length > 1 ? batch : undefined });
				return;
			}
			case "y":
				this.done({ kind: "reference", item, items });
				return;
			default:
				break;
		}
	}

	private activeItems(): QueueItem[] {
		return this.mode.visibleItems();
	}

	private handleFilterInput(key: string, data: string): void {
		if (key === "escape") {
			this.filtering = false;
			return;
		}
		if (key === "return") {
			this.filtering = false;
			this.mode.setFilter(this.filterDraft.trim());
			this.queueScroll = 0;
			return;
		}
		if (key === "tab") {
			// Tab in search mode toggles selection on the currently highlighted item
			this.toggleSelection();
			return;
		}
		if (key === "down") {
			this.move(1);
			return;
		}
		if (key === "up") {
			this.move(-1);
			return;
		}
		if (key === "A") {
			this.mode.selectAllVisible();
			return;
		}
		if (key === "backspace") {
			this.filterDraft = this.filterDraft.slice(0, -1);
			return;
		}
		if (data === " " || key === "space") {
			this.filterDraft += " ";
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filterDraft += data;
		}
	}
	private move(delta: number): void {
		if (this.pane === "queue") {
			this.mode.move(delta);
			this.traceCursor = 0;
			return;
		}
		const ids = this.traceIds(Date.now());
		if (ids.length === 0) return;
		this.traceCursor = Math.min(ids.length - 1, Math.max(0, this.traceCursor + delta));
	}

	private jump(target: number): void {
		if (this.pane === "queue") {
			this.mode.cursor = Math.min(target, Math.max(0, this.mode.visibleItems().length - 1));
			this.traceCursor = 0;
			return;
		}
		this.traceCursor = Math.min(target, Math.max(0, this.traceIds(Date.now()).length - 1));
	}
	private toggleSelection(): void {
		this.mode.toggleSelected();
		this.move(1);
	}

	private chosenItems(): QueueItem[] {
		return this.mode.chosenItems();
	}

	// ---- rendering -----------------------------------------------------------

	private headerRow(width: number, now: number): string {
		const tally = this.mode.ciTally();
		const parts = [
			this.painter.bold(this.painter.fg("accent", `${GLYPH.hex} bluefin review`)),
			this.painter.fg("dim", GLYPH.logDashed.trim()),
			this.painter.bold(this.painter.fg("text", this.mode.queueMode === "prs" ? "PULL REQUESTS" : "ISSUES")),
			this.painter.fg("text", this.mode.position()),
			this.painter.fg("dim", GLYPH.dot),
			this.painter.fg("dim", this.mode.scopeLabel()),
			this.painter.fg("dim", GLYPH.dot),
			this.painter.fg("success", `${statusIcon("success")}${tally.success}`),
			this.painter.fg("error", `${statusIcon("failure")}${tally.failure}`),
			this.painter.fg("warning", `${GLYPH.running}${tally.pending}`),
			this.painter.fg("dim", GLYPH.dot),
			this.painter.fg(
				this.mode.queueError ? "error" : "dim",
				this.mode.queueError ??
					(this.mode.loading
						? `${this.painter.fg("warning", statusIcon("running", this.frame))} ${this.painter.fg("warning", "refreshing…")}`
						: `${formatDuration(Math.max(0, now - this.mode.fetchedAt))} ago`),
			),
		];
		const source = orderSourceLabel(this.mode);
		const sourceText = this.mode.hiveOnly && this.mode.hive.online ? `${source.text} (hive-only)` : source.text;
		if (this.mode.hiveLevel !== undefined) {
			parts.push(this.painter.fg("dim", GLYPH.dot), this.painter.fg("warning", `stage ${this.mode.hiveLevel}`));
		}
		parts.push(this.painter.fg("dim", GLYPH.dot), this.painter.fg(source.role, sourceText));
		for (const group of this.mode.hive.triage) {
			if (group.count > 0) parts.push(this.painter.fg("dim", `${group.label.toLowerCase()} ${group.count}`));
		}
		return truncateToWidth(parts.join(" "), width);
	}

	private queueRows(width: number, height: number): string[] {
		this.queueRowItems = [];
		const items = this.activeItems();
		const rows: string[] = [];
		if (items.length === 0) {
			let emptyMsg: string;
			if (this.mode.loading) {
				emptyMsg = `  ${this.painter.fg("warning", statusIcon("running", this.frame))} loading queue…`;
			} else if (this.mode.hiveOnly && this.mode.hive.online && this.mode.items.length > 0) {
				emptyMsg = `  no Hive-ranked ${this.mode.queueMode} (${this.mode.items.length} unranked open — press H to show all, i for ${this.mode.queueMode === "prs" ? "issues" : "prs"})`;
			} else {
				emptyMsg = "  nothing open";
			}
			rows.push(this.painter.fg("dim", emptyMsg));
			return rows;
		}

		this.queueScroll = clampScroll(this.mode.cursor, this.queueScroll, height);
		let lastRepo: string | undefined;
		for (let i = this.queueScroll; i < Math.min(items.length, this.queueScroll + height); i++) {
			const item = items[i]!;
			// For issue queues or multi-repo queues, delineate transitions between repositories
			if (item.repo !== lastRepo) {
				if (lastRepo !== undefined && rows.length < height) {
					const divider = `─── ${item.repo} `.padEnd(width, "─");
					rows.push(truncateToWidth(this.painter.fg("dim", divider), width));
					this.queueRowItems.push("divider");
				}
				lastRepo = item.repo;
			}
			if (rows.length >= height) break;

			const active = i === this.mode.cursor;
			const isChecked = this.mode.selectedKeys.has(`${item.repo}#${item.id}`);
			const check = isChecked ? this.painter.fg("accent", "☒") : this.painter.fg("dim", "☐");
			const ci = ciGlyph(item.ciStatus);
			const caret = active
				? this.painter.inverse(GLYPH.caretClosed)
				: this.painter.fg("dim", GLYPH.leaf);
			const number = this.painter.fg("accent", `#${item.id}`);
			const icon = this.painter.fg(statusRole(ci.status), ci.glyph);
			const title = active
				? this.painter.bold(this.painter.fg("text", item.title))
				: this.painter.fg("text", item.title);
			const chip = priorityChip(this.painter, this.mode.priorityFor(item));
			const meta = this.painter.fg("dim", ` ${GLYPH.dot} ${shortRepo(item.repo)} @${item.author}`);
			rows.push(truncateToWidth(`${caret} ${check} ${icon} ${chip ? `${chip} ` : ""}${number} ${title}${meta}`, width));
			this.queueRowItems.push(i);
		}

		if (items.length > this.queueScroll + height) {
			rows[rows.length - 1] = truncateToWidth(
				this.painter.fg("dim", `${GLYPH.logDashed}…${items.length - (this.queueScroll + height) + 1} more`),
				width,
			);
		}
		return rows;
	}

	/**
	 * What Hive knows about the selected row.
	 *
	 * Hive's queue is mostly issues, and an issue has no recorded pipeline, so
	 * the pane that exists to explain the selection was blank for exactly the
	 * work this tool is pointed at. This is the drill-down: why it is ranked
	 * where it is, what stage Hive has it at, and whether a change already
	 * exists that would close it.
	 */
	private hiveRows(width: number): string[] {
		const item = this.mode.selected();
		if (!item) return [];
		const work = this.mode.hiveWorkFor(item);
		const priority = this.mode.priorityFor(item);
		if (!work && priority?.hiveRank === undefined) return [];

		const rows: string[] = [];
		const rank = priority?.hiveRank === undefined ? "" : `hive #${priority.hiveRank + 1}`;
		const stage = work?.level ? ` ${GLYPH.dot} stage ${work.level}` : "";
		rows.push(truncateToWidth(`  ${this.painter.fg("accent", rank)}${this.painter.fg("dim", stage)}`, width));
		// The reason only earns a row when it says something the rank and stage
		// above it do not: `hive <level> #<n>` is the same sentence twice.
		if (priority?.reason && priority.hiveRank === undefined) {
			rows.push(truncateToWidth(this.painter.fg("dim", `  ${priority.reason}`), width));
		}
		const claimedBy = this.mode.claimFor(item);
		if (claimedBy) {
			rows.push(truncateToWidth(this.painter.fg("warning", `  a worker is on this now: ${claimedBy}`), width));
		}
		if (work && work.key !== `${item.repo}#${item.id}`) {
			// Ranked through the issue it closes, not on its own name.
			rows.push(truncateToWidth(this.painter.fg("dim", `  queued as ${work.key}`), width));
		}
		if (work?.labels.length) {
			rows.push(truncateToWidth(this.painter.fg("dim", `  labels ${work.labels.join(", ")}`), width));
		}
		if (work?.url) rows.push(truncateToWidth(this.painter.fg("dim", `  ${work.url}`), width));

		// Changes that already answer this queued work, so a maintainer never
		// starts an issue somebody has already finished. Hive's own link is
		// authoritative and survives a queue window that never fetched the pull
		// request; the fetched queue adds any others that close the same issue.
		const answering = this.mode.items.filter(
			(candidate) => candidate.type === "pr" && (candidate.closingIssues ?? []).includes(work?.key ?? ""),
		);
		if (work?.pr) {
			const state = work.pr.state ? ` ${GLYPH.dot} ${work.pr.state}` : "";
			rows.push(
				truncateToWidth(
					`  ${this.painter.fg("accent", `#${work.pr.number}`)}${this.painter.fg("dim", `${state} ${GLYPH.dot} hive`)}`,
					width,
				),
			);
		}
		for (const pr of answering) {
			if (pr.id === work?.pr?.number) continue;
			const ci = ciGlyph(pr.ciStatus);
			rows.push(
				truncateToWidth(
					`  ${this.painter.fg(statusRole(ci.status), ci.glyph)} ${this.painter.fg("accent", `#${pr.id}`)} ${this.painter.fg("text", pr.title)}`,
					width,
				),
			);
		}
		if (item.type === "issue" && item.closedByPrs && item.closedByPrs.length > 0) {
			rows.push(
				truncateToWidth(
					`  ${this.painter.fg("accent", "merged PR:")} ${this.painter.fg("warning", item.closedByPrs.join(", "))} ${this.painter.fg("dim", "(slay to verify and close)")}`,
					width,
				),
			);
		} else if (work && !work.pr && answering.length === 0) {
			rows.push(truncateToWidth(this.painter.fg("dim", "  no open change closes this yet"), width));
		}
		rows.push("");
		return rows;
	}

	private traceRows(width: number, height: number, now: number): string[] {
		this.traceRowSpans = [];
		const hive = this.hiveRows(width);
		for (let i = 0; i < hive.length; i++) {
			this.traceRowSpans.push("hive");
		}
		const roots = this.traceRoots(now);
		if (roots.length === 0) {
			this.traceRowSpans.push(undefined);
			return [...hive, this.painter.fg("dim", `  ${statusIcon("pending")} no pipeline state recorded yet`)];
		}
		const ids = this.traceIds(now);
		this.traceCursor = Math.min(this.traceCursor, Math.max(0, ids.length - 1));
		const focusedId = this.pane === "trace" ? ids[this.traceCursor] : undefined;

		const rendered: RenderedRow[] = renderSpanTree(roots, {
			painter: this.painter,
			width,
			now,
			frame: this.frame,
			expansion: this.expansion,
			focusedId,
			maxLogLines: Math.max(3, Math.floor((height - hive.length) / 3)),
		});

		if (focusedId === undefined) {
			// Nothing is under the cursor: follow the tail while work is in flight,
			// the way a build log does, so the running step stays on screen.
			const live = roots.some((span) => span.status === "running");
			this.traceScroll = live ? Math.max(0, rendered.length - height) : 0;
		} else {
			const cursorRow = rendered.findIndex((row) => row.kind === "span" && row.spanId === focusedId);
			this.traceScroll = clampScroll(Math.max(0, cursorRow), this.traceScroll, height);
		}
		const spanSlice = rendered.slice(this.traceScroll, this.traceScroll + Math.max(1, height - hive.length));
		for (const row of spanSlice) {
			if (row.kind === "span") {
				this.traceRowSpans.push(row.spanId);
			} else {
				this.traceRowSpans.push(undefined);
			}
		}
		const spans = spanSlice.map((row) => row.text);
		return [...hive, ...spans];
	}

	private paneTitle(pane: Pane, text: string, width: number): string {
		const focused = this.pane === pane;
		const marker = focused ? this.painter.fg("accent", GLYPH.caretOpen) : this.painter.fg("dim", GLYPH.caretClosed);
		const label = focused ? this.painter.bold(this.painter.fg("text", text)) : this.painter.fg("dim", text);
		return truncateToWidth(`${marker} ${label}`, width);
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const now = Date.now();
		const lines: string[] = [this.headerRow(width, now), this.painter.fg("border", "─".repeat(width))];

		if (this.showHelp) {
			for (const bannerLine of BLUEFIN_RAPTOR_BANNER) {
				lines.push(truncateToWidth(this.painter.fg("accent", bannerLine), width));
			}
			lines.push("");
			for (const line of HELP) lines.push(truncateToWidth(this.painter.fg(line.startsWith("  ") ? "dim" : "text", line), width));
			lines.push(keymapBar(this.painter, [{ chord: "?", label: "back" }], width));
			return lines;
		}
		const bodyHeight = Math.max(4, this.rows - 4);
		const item = this.mode.selected();
		const traceTitle = item ? `TRACE ${item.repo}#${item.id}` : "TRACE";

		if (width >= SPLIT_MIN_WIDTH) {
			const leftWidth = Math.floor((width - 3) / 2);
			const rightWidth = width - leftWidth - 3;
			const queueTitle = this.mode.selectedKeys.size > 0
				? `QUEUE ${this.mode.position()} (${this.mode.selectedKeys.size} selected)`
				: `QUEUE ${this.mode.position()}`;
			const left = [this.paneTitle("queue", queueTitle, leftWidth), ...this.queueRows(leftWidth, bodyHeight - 1)];
			const right = [this.paneTitle("trace", traceTitle, rightWidth), ...this.traceRows(rightWidth, bodyHeight - 1, now)];
			const separator = this.painter.fg("border", GLYPH.railBar.trim());

			for (let i = 0; i < bodyHeight; i++) {
				const leftCell = fitToWidth(left[i] ?? "", leftWidth);
				const rightCell = right[i] ?? "";
				lines.push(truncateToWidth(`${leftCell} ${separator} ${rightCell}`, width));
			}
		} else {
			const queueHeight = Math.max(3, Math.floor((bodyHeight - 2) / 2));
			const queueTitle = this.mode.selectedKeys.size > 0
				? `QUEUE ${this.mode.position()} (${this.mode.selectedKeys.size} selected)`
				: `QUEUE ${this.mode.position()}`;
			lines.push(this.paneTitle("queue", queueTitle, width));
			lines.push(...this.queueRows(width, queueHeight));
			lines.push(this.paneTitle("trace", traceTitle, width));
			lines.push(...this.traceRows(width, bodyHeight - queueHeight - 2, now));
		}
		if (this.filtering) {
			const searchPrompt = `${this.painter.fg("accent", "search")} ${this.painter.fg("text", this.filterDraft)}${this.painter.inverse(" ")}`;
			const hints = this.painter.fg("dim", "  (tab/space: select · ↑/↓: navigate · A: select all · enter: done · esc: cancel)");
			lines.push(truncateToWidth(`${searchPrompt}${hints}`, width));
		} else if (this.mode.filter) {
			lines.push(truncateToWidth(this.painter.fg("dim", `filter: ${this.mode.filter}  (/ to search · esc/clear to reset)`), width));
		}
		lines.push(keymapBar(this.painter, DASHBOARD_KEYS, width));
		lines.push(tmuxReviewStatusBar(this.mode, this.painter, width, now));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.disableMouse();
		this.stopTick?.();
		this.stopTick = undefined;
	}
}

/** Keep `cursor` inside a `height`-row window without jumping the viewport. */
function clampScroll(cursor: number, scroll: number, height: number): number {
	if (height <= 0) return 0;
	if (cursor < scroll) return cursor;
	if (cursor >= scroll + height) return cursor - height + 1;
	return scroll;
}

function shortRepo(repo: string): string {
	const slash = repo.indexOf("/");
	return slash < 0 ? repo : repo.slice(slash + 1);
}
