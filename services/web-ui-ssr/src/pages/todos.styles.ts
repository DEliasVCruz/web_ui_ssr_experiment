import { css } from "../../styled-system/css";

export const heading = css({
	marginBlockEnd: "1rem",
	color: "brand",
	fontSize: "2rem",
	fontWeight: 700,
});

export const list = css({
	margin: 0,
	padding: 0,
	listStyle: "none",
});

export const item = css({
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
	borderBlockEnd: "1px solid {colors.border}",
	padding: "0.75rem 1rem",
	_last: {
		borderBlockEnd: "none",
	},
});

export const checkbox = css({
	flexShrink: 0,
	cursor: "default",
	blockSize: "1.25rem",
	inlineSize: "1.25rem",
	accentColor: "brand",
});

export const titleText = css({
	flex: 1,
	textDecoration: "none",
	color: "fg",
	fontSize: "1rem",
	_hover: {
		color: "brand",
	},
});

export const titleCompleted = css({
	flex: 1,
	textDecoration: "line-through",
	color: "fg.subtle",
	fontSize: "1rem",
});

export const timestamp = css({
	whiteSpace: "nowrap",
	color: "fg.subtle",
	fontSize: "0.75rem",
});

export const emptyState = css({
	padding: "2rem",
	textAlign: "center",
	color: "fg.muted",
});

export const addForm = css({
	display: "flex",
	gap: "0.5rem",
	marginBlockEnd: "1rem",
});

export const errorMessage = css({
	padding: "0.5rem 0",
	color: "danger",
	fontSize: "0.875rem",
});

// Layout-only helper: keeps a control from shrinking inside the flex row.
// Merged onto the Ark Button (which supplies its own color/border variant).
export const controlShrink = css({
	flexShrink: 0,
});
