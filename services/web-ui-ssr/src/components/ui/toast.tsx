import { Toast as ArkToast, Toaster as ArkToaster, createToaster } from "@ark-ui/solid";
import { Show } from "solid-js";
import { sva } from "../../../styled-system/css";

// Ark UI Toast (ol9.5). The toaster store is a module-level singleton so route
// components can emit toasts and the app shell (__root.tsx) can render the
// region. Toasts are only ever created by client interactions, so during SSR
// and at hydration the region is empty and identical on both sides — no
// hydration mismatch. Portaled/measured work happens in client-only effects.
export const toaster = createToaster({
	placement: "bottom-end",
	gap: 12,
});

const toastRecipe = sva({
	slots: ["root", "title", "description", "closeTrigger"],
	base: {
		root: {
			pos: "relative",
			display: "flex",
			flexDir: "column",
			gap: "1",
			minInlineSize: "toastMin",
			maxInlineSize: "toastMax",
			rounded: "md",
			borderStart: "accent",
			bgColor: "surface",
			py: "3",
			pe: "9",
			ps: "3.5",
			shadow: "toast",
			"&[data-type='success']": {
				borderStartColor: "success.fg",
			},
			"&[data-type='error']": {
				borderStartColor: "danger",
			},
		},
		title: {
			color: "fg",
			fontSize: "sm",
			fontWeight: "semibold",
		},
		description: {
			color: "fg.muted",
			fontSize: "xs",
		},
		closeTrigger: {
			pos: "absolute",
			insetBlockStart: "1.5",
			insetEnd: "2",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			border: "none",
			rounded: "sm",
			bgColor: "transparent",
			color: "fg.muted",
			cursor: "pointer",
			fontSize: "md",
			lineHeight: "none",
		},
	},
});

const styles = toastRecipe();

export function Toaster() {
	return (
		<ArkToaster toaster={toaster}>
			{(toast) => (
				<ArkToast.Root class={styles.root}>
					<ArkToast.Title class={styles.title}>{toast().title}</ArkToast.Title>
					<Show when={toast().description}>
						<ArkToast.Description class={styles.description}>
							{toast().description}
						</ArkToast.Description>
					</Show>
					<ArkToast.CloseTrigger class={styles.closeTrigger} aria-label="Dismiss notification">
						×
					</ArkToast.CloseTrigger>
				</ArkToast.Root>
			)}
		</ArkToaster>
	);
}

// Convenience emitters used by the todo mutations.
export const toast = {
	success: (title: string, description?: string) =>
		toaster.create({ title, description, type: "success" }),
	error: (title: string, description?: string) =>
		toaster.create({ title, description, type: "error" }),
};
