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

export const addInput = css({
	flex: 1,
	outline: "none",
	border: "1px solid {colors.border.input}",
	borderRadius: "0.375rem",
	padding: "0.5rem 0.75rem",
	fontSize: "1rem",
	_focus: {
		borderColor: "brand",
		boxShadow: "0 0 0 2px {colors.brand.focusRing}",
	},
});

export const addButton = css({
	border: "none",
	borderRadius: "0.375rem",
	backgroundColor: "brand",
	cursor: "pointer",
	padding: "0.5rem 1rem",
	color: "brand.contrast",
	fontSize: "1rem",
	fontWeight: 600,
	_disabled: {
		opacity: 0.5,
		cursor: "default",
	},
});

export const errorMessage = css({
	padding: "0.5rem 0",
	color: "danger",
	fontSize: "0.875rem",
});

export const deleteButton = css({
	flexShrink: 0,
	border: "1px solid {colors.danger}",
	borderRadius: "0.25rem",
	backgroundColor: "transparent",
	cursor: "pointer",
	padding: "0.25rem 0.5rem",
	color: "danger",
	fontSize: "0.75rem",
	_disabled: {
		opacity: 0.5,
		cursor: "default",
	},
});
