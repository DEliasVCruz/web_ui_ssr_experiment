import { css } from "../../styled-system/css";

export const heading = css({
	marginBlockEnd: "1rem",
	color: "#2563eb",
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
	borderBlockEnd: "1px solid #e5e7eb",
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
	accentColor: "#2563eb",
});

export const titleText = css({
	flex: 1,
	textDecoration: "none",
	color: "#1f2937",
	fontSize: "1rem",
	_hover: {
		color: "#2563eb",
	},
});

export const titleCompleted = css({
	flex: 1,
	textDecoration: "line-through",
	color: "#9ca3af",
	fontSize: "1rem",
});

export const timestamp = css({
	whiteSpace: "nowrap",
	color: "#9ca3af",
	fontSize: "0.75rem",
});

export const emptyState = css({
	padding: "2rem",
	textAlign: "center",
	color: "#6b7280",
});

export const addForm = css({
	display: "flex",
	gap: "0.5rem",
	marginBlockEnd: "1rem",
});

export const addInput = css({
	flex: 1,
	outline: "none",
	border: "1px solid #d1d5db",
	borderRadius: "0.375rem",
	padding: "0.5rem 0.75rem",
	fontSize: "1rem",
	_focus: {
		borderColor: "#2563eb",
		boxShadow: "0 0 0 2px rgba(37,99,235,0.2)",
	},
});

export const addButton = css({
	border: "none",
	borderRadius: "0.375rem",
	backgroundColor: "#2563eb",
	cursor: "pointer",
	padding: "0.5rem 1rem",
	color: "#fff",
	fontSize: "1rem",
	fontWeight: 600,
	_disabled: {
		opacity: 0.5,
		cursor: "default",
	},
});

export const errorMessage = css({
	padding: "0.5rem 0",
	color: "#ef4444",
	fontSize: "0.875rem",
});

export const deleteButton = css({
	flexShrink: 0,
	border: "1px solid #ef4444",
	borderRadius: "0.25rem",
	backgroundColor: "transparent",
	cursor: "pointer",
	padding: "0.25rem 0.5rem",
	color: "#ef4444",
	fontSize: "0.75rem",
	_disabled: {
		opacity: 0.5,
		cursor: "default",
	},
});
