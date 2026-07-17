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
