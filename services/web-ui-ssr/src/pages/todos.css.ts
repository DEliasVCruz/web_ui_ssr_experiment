import { style } from "@vanilla-extract/css";

export const heading = style({
	fontSize: "2rem",
	fontWeight: 700,
	marginBottom: "1rem",
	color: "#2563eb",
});

export const list = style({
	listStyle: "none",
	padding: 0,
	margin: 0,
});

export const item = style({
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
	padding: "0.75rem 1rem",
	borderBottom: "1px solid #e5e7eb",
	selectors: {
		"&:last-child": {
			borderBottom: "none",
		},
	},
});

export const checkbox = style({
	width: "1.25rem",
	height: "1.25rem",
	flexShrink: 0,
	accentColor: "#2563eb",
	cursor: "default",
});

export const titleText = style({
	flex: 1,
	fontSize: "1rem",
	color: "#1f2937",
});

export const titleCompleted = style({
	flex: 1,
	fontSize: "1rem",
	color: "#9ca3af",
	textDecoration: "line-through",
});

export const timestamp = style({
	fontSize: "0.75rem",
	color: "#9ca3af",
	whiteSpace: "nowrap",
});

export const emptyState = style({
	padding: "2rem",
	textAlign: "center",
	color: "#6b7280",
});

export const addForm = style({
	display: "flex",
	gap: "0.5rem",
	marginBottom: "1rem",
});

export const addInput = style({
	flex: 1,
	padding: "0.5rem 0.75rem",
	fontSize: "1rem",
	border: "1px solid #d1d5db",
	borderRadius: "0.375rem",
	outline: "none",
	selectors: {
		"&:focus": {
			borderColor: "#2563eb",
			boxShadow: "0 0 0 2px rgba(37,99,235,0.2)",
		},
	},
});

export const addButton = style({
	padding: "0.5rem 1rem",
	fontSize: "1rem",
	fontWeight: 600,
	color: "#fff",
	backgroundColor: "#2563eb",
	border: "none",
	borderRadius: "0.375rem",
	cursor: "pointer",
	selectors: {
		"&:disabled": {
			opacity: 0.5,
			cursor: "default",
		},
	},
});

export const errorMessage = style({
	color: "#ef4444",
	fontSize: "0.875rem",
	padding: "0.5rem 0",
});

export const deleteButton = style({
	padding: "0.25rem 0.5rem",
	fontSize: "0.75rem",
	color: "#ef4444",
	backgroundColor: "transparent",
	border: "1px solid #ef4444",
	borderRadius: "0.25rem",
	cursor: "pointer",
	flexShrink: 0,
	selectors: {
		"&:disabled": {
			opacity: 0.5,
			cursor: "default",
		},
	},
});
