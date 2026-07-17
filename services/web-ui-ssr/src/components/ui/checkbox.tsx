import { Checkbox as ArkCheckbox } from "@ark-ui/solid";
import { splitProps } from "solid-js";
import { sva } from "../../../styled-system/css";

// Ark UI Checkbox (headless, accessible) styled with a Panda slot recipe.
// Renders a native <input type="checkbox"> (Checkbox.HiddenInput) for SSR +
// form semantics plus a styled Control/Indicator. IDs come from Solid
// createUniqueId (deterministic across SSR/hydrate); no portal, so it hydrates
// in place with no mismatch.
const checkboxRecipe = sva({
	slots: ["root", "control", "indicator"],
	base: {
		root: {
			display: "inline-flex",
			flexShrink: 0,
			alignItems: "center",
			cursor: "pointer",
			_disabled: {
				cursor: "default",
				opacity: 0.5,
			},
		},
		control: {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			blockSize: "5",
			inlineSize: "5",
			border: "control",
			rounded: "sm",
			bgColor: "transparent",
			color: "brand.contrast",
			transition: "colors",
			_checked: {
				bgColor: "brand",
				borderColor: "brand",
			},
		},
		indicator: {
			display: "inline-flex",
			fontSize: "sm",
			lineHeight: "none",
		},
	},
});

const styles = checkboxRecipe();

export type CheckboxProps = ArkCheckbox.RootProps & { "aria-label"?: string };

export function Checkbox(props: CheckboxProps) {
	const [local, rootProps] = splitProps(props, ["aria-label"]);
	return (
		<ArkCheckbox.Root {...rootProps} class={styles.root}>
			<ArkCheckbox.Control class={styles.control}>
				<ArkCheckbox.Indicator class={styles.indicator}>✓</ArkCheckbox.Indicator>
			</ArkCheckbox.Control>
			<ArkCheckbox.HiddenInput aria-label={local["aria-label"]} />
		</ArkCheckbox.Root>
	);
}
