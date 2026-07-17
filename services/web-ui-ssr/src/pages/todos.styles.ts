import { css } from "../../styled-system/css";

export const heading = css({
	marginBlockEnd: "4",
	color: "brand",
	fontSize: "heading",
	fontWeight: "bold",
});

export const list = css({
	m: "0",
	p: "0",
	listStyle: "none",
});

export const item = css({
	display: "flex",
	alignItems: "center",
	gap: "3",
	borderBlockEnd: "divider",
	py: "3",
	px: "4",
	_last: {
		borderBlockEnd: "none",
	},
});

export const titleText = css({
	flex: "1",
	textDecoration: "none",
	color: "fg",
	fontSize: "md",
	_hover: {
		color: "brand",
	},
});

export const titleCompleted = css({
	flex: "1",
	textDecoration: "line-through",
	color: "fg.subtle",
	fontSize: "md",
});

export const timestamp = css({
	whiteSpace: "nowrap",
	color: "fg.subtle",
	fontSize: "xs",
});

export const emptyState = css({
	p: "8",
	textAlign: "center",
	color: "fg.muted",
});

export const addForm = css({
	display: "flex",
	gap: "2",
	marginBlockEnd: "4",
});

// Layout-only helper: keeps a control from shrinking inside the flex row.
// Merged onto the Ark Button (which supplies its own color/border variant).
export const controlShrink = css({
	flexShrink: 0,
});

// Visually hidden but present for assistive tech — used for the Add-form
// Field.Label so the input has a real accessible name (aria-labelledby) while
// the visible UI is unchanged.
export const srOnly = css({
	srOnly: true,
});
