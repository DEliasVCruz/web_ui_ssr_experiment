import { css } from "../../styled-system/css";

export const backLink = css({
	display: "inline-block",
	marginBlockEnd: "6",
	textDecoration: "none",
	color: "brand",
	fontSize: "sm",
	_hover: {
		textDecoration: "underline",
	},
});

export const title = css({
	marginBlockEnd: "2",
	color: "fg",
	fontSize: "title",
	fontWeight: "bold",
});

export const titleCompleted = css({
	marginBlockEnd: "2",
	textDecoration: "line-through",
	color: "fg.subtle",
	fontSize: "title",
	fontWeight: "bold",
});

export const statusBadge = css({
	display: "inline-block",
	marginBlockEnd: "4",
	rounded: "full",
	py: "1",
	px: "3",
	fontSize: "xs",
	fontWeight: "semibold",
});

export const statusComplete = css({
	bgColor: "success.bg",
	color: "success.fg",
});

export const statusPending = css({
	bgColor: "warning.bg",
	color: "warning.fg",
});

export const meta = css({
	display: "flex",
	flexDir: "column",
	gap: "1",
	marginBlockStart: "4",
	color: "fg.muted",
	fontSize: "sm",
});

// The details block: a labelled section holding either the rendered notes or an
// empty-state line, plus the edit affordance.
export const detailsSection = css({
	display: "flex",
	flexDir: "column",
	gap: "2",
	marginBlockStart: "6",
});

export const detailsHeading = css({
	color: "fg",
	fontSize: "md",
	fontWeight: "semibold",
});

// Rendered details. `pre-wrap` preserves the author's newlines and runs of
// spaces (a notes field), while `break-word` stops a long unbroken token from
// overflowing the content column.
export const detailsText = css({
	color: "fg",
	fontSize: "md",
	whiteSpace: "pre-wrap",
	overflowWrap: "break-word",
});

// Shown when the todo has no details (never set, or cleared — display treats
// both identically; see the route note on presence equivalence).
export const detailsEmpty = css({
	color: "fg.muted",
	fontSize: "md",
	fontStyle: "italic",
});

export const editForm = css({
	display: "flex",
	flexDir: "column",
	gap: "2",
	marginBlockStart: "2",
});

export const editActions = css({
	display: "flex",
	gap: "2",
});
