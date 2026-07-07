import { Dialog as ArkDialog } from "@ark-ui/solid";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { sva } from "../../../styled-system/css";

// Ark UI Dialog (headless, accessible: focus trap, ESC-to-close, aria-modal)
// styled with a Panda slot recipe. The overlay parts live under a Solid <Portal>
// and Ark only mounts them while the dialog is OPEN — which is never during SSR
// or at hydration time (dialogs start closed), so the Portal takes no part in
// hydration and cannot cause a mismatch. Trigger IDs come from Solid
// createUniqueId (deterministic across SSR/hydrate).
const dialogRecipe = sva({
	slots: ["backdrop", "positioner", "content", "title", "description", "actions"],
	base: {
		backdrop: {
			position: "fixed",
			inset: 0,
			backgroundColor: "overlay",
			zIndex: 1000,
		},
		positioner: {
			position: "fixed",
			inset: 0,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			padding: "1rem",
			zIndex: 1001,
		},
		content: {
			inlineSize: "100%",
			maxInlineSize: "24rem",
			borderRadius: "0.5rem",
			backgroundColor: "surface",
			padding: "1.5rem",
			boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
		},
		title: {
			marginBlockEnd: "0.5rem",
			color: "fg",
			fontSize: "1.25rem",
			fontWeight: 700,
		},
		description: {
			marginBlockEnd: "1.25rem",
			color: "fg.muted",
			fontSize: "0.9rem",
		},
		actions: {
			display: "flex",
			justifyContent: "flex-end",
			gap: "0.5rem",
		},
	},
});

const styles = dialogRecipe();

// PascalCase keys follow the Ark UI compound-component naming convention.
export const Dialog = {
	Root: ArkDialog.Root,
	Trigger: ArkDialog.Trigger,
	CloseTrigger: ArkDialog.CloseTrigger,
	Portal,
	Backdrop: (props: ArkDialog.BackdropProps) => (
		<ArkDialog.Backdrop {...props} class={styles.backdrop} />
	),
	Positioner: (props: ArkDialog.PositionerProps) => (
		<ArkDialog.Positioner {...props} class={styles.positioner} />
	),
	Content: (props: ArkDialog.ContentProps) => (
		<ArkDialog.Content {...props} class={styles.content} />
	),
	Title: (props: ArkDialog.TitleProps) => <ArkDialog.Title {...props} class={styles.title} />,
	Description: (props: ArkDialog.DescriptionProps) => (
		<ArkDialog.Description {...props} class={styles.description} />
	),
	Actions: (props: { children: JSX.Element }) => <div class={styles.actions}>{props.children}</div>,
};
