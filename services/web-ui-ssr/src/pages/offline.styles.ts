import { css } from "../../styled-system/css";

// Offline UX styling (task 1w9.4 §4.6). Token-only under strictTokens: the
// warning semantic set (bg/fg) already exists for exactly this "attention, not
// error" register — an offline banner and a stale-data indicator are advisory,
// not failures.

/** App-shell offline banner: full-width advisory strip. */
export const offlineBanner = css({
	bgColor: "warning.bg",
	color: "warning.fg",
	py: "2",
	px: "4",
	textAlign: "center",
	fontSize: "sm",
	fontWeight: "medium",
});

/** Inline "showing saved data" pill shown when data is visible but a background
 *  refetch failed (the data && isError path — 1w9.3 review F2). */
export const staleIndicator = css({
	display: "inline-block",
	bgColor: "warning.bg",
	color: "warning.fg",
	py: "1",
	px: "3",
	rounded: "sm",
	fontSize: "xs",
	fontWeight: "medium",
	marginBlockEnd: "2",
});

/** Designed route-level error/offline message body (errorComponent — 1w9.3
 *  review F1), replacing TanStack's generic error screen. */
export const offlineError = css({
	py: "6",
	color: "fg.muted",
});

export const offlineErrorHeading = css({
	fontSize: "xl",
	fontWeight: "semibold",
	color: "fg",
	marginBlockEnd: "2",
});
