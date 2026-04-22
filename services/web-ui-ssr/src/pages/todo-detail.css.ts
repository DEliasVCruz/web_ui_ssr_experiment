import { style } from "@vanilla-extract/css";

export const backLink = style({
	display: "inline-block",
	marginBottom: "1.5rem",
	color: "#2563eb",
	textDecoration: "none",
	fontSize: "0.875rem",
	selectors: {
		"&:hover": {
			textDecoration: "underline",
		},
	},
});

export const title = style({
	fontSize: "1.75rem",
	fontWeight: 700,
	marginBottom: "0.5rem",
	color: "#1f2937",
});

export const titleCompleted = style({
	fontSize: "1.75rem",
	fontWeight: 700,
	marginBottom: "0.5rem",
	color: "#9ca3af",
	textDecoration: "line-through",
});

export const statusBadge = style({
	display: "inline-block",
	padding: "0.25rem 0.75rem",
	borderRadius: "9999px",
	fontSize: "0.75rem",
	fontWeight: 600,
	marginBottom: "1rem",
});

export const statusComplete = style({
	backgroundColor: "#d1fae5",
	color: "#065f46",
});

export const statusPending = style({
	backgroundColor: "#fef3c7",
	color: "#92400e",
});

export const meta = style({
	fontSize: "0.875rem",
	color: "#6b7280",
	display: "flex",
	flexDirection: "column",
	gap: "0.25rem",
	marginTop: "1rem",
});
