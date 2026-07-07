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
			position: "relative",
			display: "flex",
			flexDirection: "column",
			gap: "0.2rem",
			minInlineSize: "15rem",
			maxInlineSize: "22rem",
			borderRadius: "0.375rem",
			borderInlineStartWidth: "4px",
			borderInlineStartStyle: "solid",
			borderInlineStartColor: "border",
			backgroundColor: "surface",
			padding: "0.75rem 2.25rem 0.75rem 0.85rem",
			boxShadow: "0 6px 18px rgba(0, 0, 0, 0.15)",
			"&[data-type='success']": {
				borderInlineStartColor: "success.fg",
			},
			"&[data-type='error']": {
				borderInlineStartColor: "danger",
			},
		},
		title: {
			color: "fg",
			fontSize: "0.9rem",
			fontWeight: 600,
		},
		description: {
			color: "fg.muted",
			fontSize: "0.8rem",
		},
		closeTrigger: {
			position: "absolute",
			insetBlockStart: "0.4rem",
			insetInlineEnd: "0.5rem",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			border: "none",
			borderRadius: "0.25rem",
			backgroundColor: "transparent",
			color: "fg.muted",
			cursor: "pointer",
			fontSize: "1.1rem",
			lineHeight: 1,
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
