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
			pos: "fixed",
			inset: "0",
			bgColor: "overlay",
			zIndex: 1000,
		},
		positioner: {
			pos: "fixed",
			inset: "0",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			p: "4",
			zIndex: 1001,
		},
		content: {
			inlineSize: "full",
			maxInlineSize: "dialog",
			rounded: "lg",
			bgColor: "surface",
			p: "6",
			shadow: "dialog",
		},
		title: {
			marginBlockEnd: "2",
			color: "fg",
			fontSize: "xl",
			fontWeight: "bold",
		},
		description: {
			marginBlockEnd: "5",
			color: "fg.muted",
			fontSize: "sm",
		},
		actions: {
			display: "flex",
			justifyContent: "flex-end",
			gap: "2",
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
