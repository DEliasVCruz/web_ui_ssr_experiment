import { css } from "../../styled-system/css";

export const backLink = css({
	display: "inline-block",
	marginBlockEnd: "1.5rem",
	textDecoration: "none",
	color: "brand",
	fontSize: "0.875rem",
	_hover: {
		textDecoration: "underline",
	},
});

export const title = css({
	marginBlockEnd: "0.5rem",
	color: "fg",
	fontSize: "1.75rem",
	fontWeight: 700,
});

export const titleCompleted = css({
	marginBlockEnd: "0.5rem",
	textDecoration: "line-through",
	color: "fg.subtle",
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
	backgroundColor: "success.bg",
	color: "success.fg",
});

export const statusPending = css({
	backgroundColor: "warning.bg",
	color: "warning.fg",
});

export const meta = css({
	display: "flex",
	flexDirection: "column",
	gap: "0.25rem",
	marginBlockStart: "1rem",
	color: "fg.muted",
	fontSize: "0.875rem",
});
