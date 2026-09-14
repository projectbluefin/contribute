/**
 * The always-on rail under the editor.
 *
 * Dagger's status line and keymap bar, sized for four rows: what the queue is,
 * what is selected, what is moving right now, and which keys act on it. It ticks
 * the spinner only while something is actually running, so an idle session costs
 * no repaints.
 */

import { hiveFailureStatus } from "./hive.ts";
import { GLYPH, SPINNER_TICK_MS, type PaintRole, type Painter, formatDuration, statusIcon, statusRole } from "./glyphs.ts";
import { type ReviewMode, ciGlyph } from "./mode.ts";
import type { Priority, PriorityCategory } from "./priority.ts";
import { spanDuration } from "./trace.ts";
import { truncateToWidth, visibleWidth } from "./width.ts";
export interface RailKey {
	chord: string;
	label: string;
}

/** Dagger's keymap bar: dim, middot-separated, no boxes. */
export function keymapBar(painter: Painter, keys: readonly RailKey[], width: number): string {
	const parts = keys.map((key) => `${painter.fg("accent", key.chord)} ${painter.fg("dim", key.label)}`);
	const separator = painter.fg("dim", ` ${GLYPH.dot} `);
	return truncateToWidth(`${painter.fg("dim", GLYPH.branchEnd)} ${parts.join(separator)}`, width);
}


/**
 * Age of the queue data, shown only once it is old enough to matter.
 *
 * A live "3.1s ago" counter forces a repaint every tick and tells you nothing you
 * did not already assume. Silence means fresh; text means stale.
 */
export const STALE_AFTER_MS = 90_000;

export function queueAge(fetchedAt: number, now: number): string | undefined {
	if (!fetchedAt) return "never fetched";
	const age = Math.max(0, now - fetchedAt);
	return age < STALE_AFTER_MS ? undefined : `stale ${formatDuration(age)}`;
}


/** Colour per category: what the eye should land on first is loudest. */
const CATEGORY_ROLE: Record<PriorityCategory, PaintRole> = {
	hive: "accent",
	"ready-for-human-merge": "success",
	review: "warning",
	"resolve-conflicts": "error",
	"fix-ci": "error",
	investigate: "dim",
	triage: "muted",
};

/** Short forms, because a queue row is not a place for a sentence. */
const CATEGORY_LABEL: Record<PriorityCategory, string> = {
	hive: "hive",
	"ready-for-human-merge": "merge",
	review: "review",
	"resolve-conflicts": "conflict",
	"fix-ci": "fix-ci",
	investigate: "look",
	triage: "triage",
};

export function priorityChip(painter: Painter, priority: Priority | undefined): string {
	if (!priority) return "";
	const label =
		priority.hiveRank === undefined ? CATEGORY_LABEL[priority.category] : `hive#${priority.hiveRank + 1}`;
	return painter.fg(CATEGORY_ROLE[priority.category], label);
}

/**
 * Where the order came from.
 *
 * "Hive says nothing is urgent" and "we could not ask Hive" are different
 * facts, and a maintainer acting on the wrong one wastes a morning.
 */
export function orderSourceLabel(mode: ReviewMode): { text: string; role: PaintRole } {
	const hive = mode.hive;
	if (!hive.configured) return { text: "GitHub evidence · unranked", role: "dim" };
	if (hive.error) return { text: hiveFailureStatus(hive.error), role: "error" };
	const coverage = mode.hiveCoverage();
	if (mode.orderSource() === "hive") {
		const actionable = hive.actionableItems === undefined ? "" : ` \u00b7 ${hive.actionableItems} actionable`;
		// present/total, not a bare count: a queue missing half of Hive's work
		// looks identical to a short queue unless it says so.
		const queued = `${coverage.present}/${coverage.total} queued`;
		return { text: `hive \u25b8 ${queued}${actionable}`, role: "accent" };
	}
	if (coverage.total > 0) {
		return { text: `hive \u25b8 0/${coverage.total} queued \u00b7 none reachable here`, role: "error" };
	}
	return { text: "Hive online · no ranked work in this view", role: "dim" };
}

export function workbenchProgressBar(mode: ReviewMode, painter: Painter, width: number): string {
	const source = orderSourceLabel(mode);
	const connection = mode.hive.online
		? painter.fg("success", "HIVE LIVE")
		: mode.hive.configured
			? painter.fg("error", "HIVE OFFLINE")
			: painter.fg("warning", "HIVE UNCONFIGURED");
	const selected = painter.fg("text", `${mode.selectedKeys.size} selected`);
	const pause = mode.paused ? painter.fg("warning", "PAUSED") : painter.fg("success", "RUNNING");
	const progress = mode.batchProgress;
	const slay = progress
		? painter.fg(
				progress.state === "blocked" ? "error" : progress.state === "paused" ? "warning" : "accent",
				`${progress.state.toUpperCase()} ${progress.completedItems}/${progress.totalItems} terminal · ${progress.runningJobs} active · ${progress.failedJobs} failed · wave ${progress.wave}/${progress.waves} ${progress.repository}`,
			)
		: painter.fg("dim", "no active slay");
	return truncateToWidth(
		`${connection} ${painter.fg("dim", GLYPH.dot)} ${painter.fg(source.role, source.text)} ${painter.fg("dim", GLYPH.dot)} ${selected} ${painter.fg("dim", GLYPH.dot)} ${pause} ${painter.fg("dim", GLYPH.dot)} ${slay}`,
		width,
	);
}

/** Build the rail's rows. Pure, so the widget test needs no terminal. */
export function renderRail(
	mode: ReviewMode,
	painter: Painter,
	width: number,
	now: number,
	frame: number,
	_keys: readonly RailKey[],
): string[] {
	const item = mode.selected();
	if (!item) {
		const spinner = painter.fg("warning", statusIcon("running", frame));
		let reasonText = "queue empty";
		if (mode.loading) reasonText = "loading queue…";
		else if (mode.hiveOnly && mode.hive.online && mode.items.length > 0) {
			reasonText = `no Hive-ranked ${mode.queueMode} (${mode.items.length} unranked open — H shows all)`;
		}
		const reason = mode.queueError
			? painter.fg("error", `${statusIcon("failure")} ${mode.queueError}`)
			: mode.loading
				? `${spinner} ${painter.fg("warning", reasonText)}`
				: painter.fg("dim", `${statusIcon("pending")} ${reasonText}`);
		return [truncateToWidth(`${painter.fg("accent", `${GLYPH.hex} hive`)} ${reason}  │  ${painter.fg("dim", "alt+b: workbench")}`, width)];
	}
	const ci = ciGlyph(item.ciStatus);
	const priority = mode.priorityFor(item);
	const chip = priorityChip(painter, priority);
	const isChecked = mode.selectedKeys.has(`${item.repo}#${item.id}`);
	const check = isChecked ? painter.fg("accent", "☒ ") : "";
	const icon = painter.fg(statusRole(ci.status), ci.glyph);
	const number = painter.fg("accent", `#${item.id}`);
	const title = painter.bold(painter.fg("text", item.title));
	const author = painter.fg("dim", `@${item.author}`);
	const pos = painter.fg("dim", `(${mode.position()})`);
	const spinner = painter.fg("warning", statusIcon("running", frame));
	const age = mode.loading ? `${spinner} ${painter.fg("warning", "refreshing…")}` : queueAge(mode.fetchedAt, now);
	const ageBadge = age ? (mode.loading ? age : painter.fg("warning", age)) : "";
	const live = liveLine(mode, painter, now, frame);
	if (live && mode.session.active()) return [truncateToWidth(live, width)];
	const source = orderSourceLabel(mode);
	const connection = mode.hive.online ? "HIVE LIVE" : mode.hive.configured ? "HIVE OFFLINE" : "HIVE UNCONFIGURED";
	const leftParts = [check, number, title, author, chip, icon].filter(Boolean);
	const status = [painter.fg(source.role, `${connection} ${source.text}`), ageBadge].filter(Boolean).join(` ${painter.fg("dim", GLYPH.dot)} `);
	const itemLine = `${leftParts.join(" ")}  │  ${painter.fg("dim", "alt+b: workbench")} ${pos}`;
	return [truncateToWidth(status, width), truncateToWidth(itemLine, width)];

}

/** The one line that answers "what is happening right now". */
function liveLine(mode: ReviewMode, painter: Painter, now: number, frame: number): string | undefined {
	const turn = mode.session.active();
	if (turn) {
		const elapsed = spanDuration(turn, now);
		return [
			painter.fg("warning", GLYPH.logBar.trim()),
			painter.fg("warning", statusIcon("running", frame)),
			painter.fg("text", turn.label),
			elapsed === undefined ? "" : painter.fg("warning", formatDuration(elapsed)),
		]
			.filter(Boolean)
			.join(" ");
	}
	return undefined;
}

interface TuiLike {
	requestRender(): void;
}

/**
 * Widget component handed to `ctx.ui.setWidget`.
 *
 * Owns exactly one timer, started only while work is in flight, and stops it as
 * soon as nothing is running: an idle review session must not repaint at 12.5 Hz.
 */
export class ReviewRail {
	private frame = 0;
	private stopTick: (() => void) | undefined;
	private cache: string[] = [];
	private cacheKey = "";

	private readonly tui: TuiLike;
	private readonly painter: Painter;
	private readonly mode: ReviewMode;
	private readonly keys: readonly RailKey[];
	private readonly isHidden?: () => boolean;

	constructor(tui: TuiLike, painter: Painter, mode: ReviewMode, keys: readonly RailKey[], isHidden?: () => boolean) {
		this.tui = tui;
		this.painter = painter;
		this.mode = mode;
		this.keys = keys;
		this.isHidden = isHidden;
	}

	private shouldAnimate(): boolean {
		return this.mode.loading || Boolean(this.mode.session.active()) || this.mode.batchProgress?.state === "running";
	}

	private syncTimer(): void {
		const wanted = this.shouldAnimate();
		if (wanted && !this.stopTick) {
			const handle = setInterval(() => {
				try {
					this.frame += 1;
					this.tui.requestRender();
				} catch {
					// A repaint failure must never escape into an uncaught exception:
					// extensions share the session process, and a throw here kills it.
				}
			}, SPINNER_TICK_MS);
			(handle as { unref?(): void }).unref?.();
			this.stopTick = () => clearInterval(handle);
		} else if (!wanted && this.stopTick) {
			this.stopTick();
			this.stopTick = undefined;
		}
	}

	render(width: number): string[] {
		if (this.isHidden?.()) return [];
		this.syncTimer();
		const now = Date.now();
		const rows = renderRail(this.mode, this.painter, width, now, this.frame, this.keys);
		// pi-tui skips work when a component returns the same array reference.
		const key = `${width}:${rows.join("\u0000")}`;
		if (key === this.cacheKey) return this.cache;
		this.cacheKey = key;
		this.cache = rows;
		return rows;
	}

	invalidate(): void {
		this.cacheKey = "";
	}

	dispose(): void {
		this.stopTick?.();
		this.stopTick = undefined;
	}
}

/** Compact segment for omp's own status bar, next to model and token counts. */
export function statusSegment(mode: ReviewMode, painter: Painter, now: number): string {
	const item = mode.selected();
	const selCount = mode.selectedKeys.size;
	const modeLabel = `${mode.queueMode === "prs" ? "PR" : "ISS"}${selCount > 0 ? ` [${selCount} sel]` : ""}`;
	const label = painter.fg("accent", `${GLYPH.hex} ${modeLabel}`);
	const position = painter.fg("dim", mode.position());
	if (!item) {
		const state = mode.queueError ? painter.fg("error", "auth") : painter.fg("dim", mode.loading ? "…" : "empty");
		return `${label} ${position} ${state}`;
	}
	const ci = ciGlyph(item.ciStatus);
	const root = mode.session.roots().at(-1);
	const stage = root ? painter.fg(statusRole(root.status), statusIcon(root.status)) : "";
	const title = item.title.length > 28 ? `${item.title.slice(0, 27)}…` : item.title;
	return [label, position, painter.fg("text", `#${item.id}`), painter.fg(statusRole(ci.status), ci.glyph), stage, painter.fg("dim", title)]
		.filter((part) => visibleWidth(part) > 0)
		.join(" ");
}
