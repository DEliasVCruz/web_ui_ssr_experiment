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
