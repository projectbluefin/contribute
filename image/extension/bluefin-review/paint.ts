/**
 * Theme adapter.
 *
 * The renderer paints through `Painter` roles; omp hands components a `Theme`.
 * Every role maps onto a real `ThemeColor`, so a Bluefin trace recolors with the
 * user's theme instead of hardcoding Dagger's ANSI palette.
 */

import type { Painter, PaintRole } from "./glyphs.ts";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

const ROLE_TO_THEME: Record<PaintRole, string> = {
	accent: "accent",
	success: "success",
	error: "error",
	warning: "warning",
	dim: "dim",
	muted: "muted",
	text: "text",
	border: "border",
	toolTitle: "toolOutput",
};

const ISSUE_ROLE_TO_THEME: Record<PaintRole, string> = {
	...ROLE_TO_THEME,
	accent: "warning",
	warning: "accent",
	border: "warning",
	toolTitle: "warning",
};


export function workbenchPainter(theme: ThemeLike, mode: () => "prs" | "issues"): Painter {
	return {
		fg: (role, text) => {
			const roles = mode() === "issues" ? ISSUE_ROLE_TO_THEME : ROLE_TO_THEME;
			return theme.fg(roles[role], text);
		},
		bold: (text) => theme.bold(text),
		inverse: (text) => theme.inverse(text),
	};
}
