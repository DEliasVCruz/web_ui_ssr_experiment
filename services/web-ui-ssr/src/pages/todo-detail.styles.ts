import { css } from "../../styled-system/css";

export const backLink = css({
	display: "inline-block",
	marginBlockEnd: "1.5rem",
	textDecoration: "none",
	color: "#2563eb",
	fontSize: "0.875rem",
	_hover: {
		textDecoration: "underline",
	},
});

export const title = css({
	marginBlockEnd: "0.5rem",
	color: "#1f2937",
	fontSize: "1.75rem",
	fontWeight: 700,
});

export const titleCompleted = css({
	marginBlockEnd: "0.5rem",
	textDecoration: "line-through",
	color: "#9ca3af",
	fontSize: "1.75rem",
	fontWeight: 700,
});

export const statusBadge = css({
	display: "inline-block",
	marginBlockEnd: "1rem",
	borderRadius: "9999rem",
	padding: "0.25rem 0.75rem",
	fontSize: "0.75rem",
	fontWeight: 600,
});

export const statusComplete = css({
	backgroundColor: "#d1fae5",
	color: "#065f46",
});

export const statusPending = css({
	backgroundColor: "#fef3c7",
	color: "#92400e",
});

export const meta = css({
	display: "flex",
	flexDirection: "column",
	gap: "0.25rem",
	marginBlockStart: "1rem",
	color: "#6b7280",
	fontSize: "0.875rem",
});
