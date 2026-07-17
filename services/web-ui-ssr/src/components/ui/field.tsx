import { Field as ArkField } from "@ark-ui/solid";
import { splitProps } from "solid-js";
import { cx, sva } from "../../../styled-system/css";

// Ark UI Field (headless, accessible) styled with a Panda slot recipe (sva).
// Field.Root generates matching IDs (Solid createUniqueId → deterministic across
// SSR/hydrate) and, for whichever parts are rendered, wires them to the input:
// a rendered Field.Label gives the input an accessible name via aria-labelledby;
// a rendered Field.ErrorText together with Root `invalid` sets aria-invalid +
// aria-describedby so the error is announced. Field.Label accepts a `class`
// (merged with the slot style) so callers can visually hide it while keeping
// the accessible name.
const fieldRecipe = sva({
	slots: ["root", "input", "label", "errorText"],
	base: {
		root: {
			display: "flex",
			flexDir: "column",
			gap: "1",
			flex: "1",
		},
		label: {
			color: "fg",
			fontSize: "sm",
			fontWeight: "semibold",
		},
		input: {
			inlineSize: "full",
			ring: "none",
			border: "control",
			rounded: "md",
			py: "2",
			px: "3",
			fontSize: "md",
			_focus: {
				borderColor: "brand",
				shadow: "focusRing",
			},
		},
		errorText: {
			py: "2",
			px: "0",
			color: "danger",
			fontSize: "sm",
		},
	},
});

const styles = fieldRecipe();

// PascalCase keys are the Ark UI compound-component naming convention
// (Field.Root, Field.Input, ...), intentionally not camelCase.
export const Field = {
	Root: (props: ArkField.RootProps) => <ArkField.Root {...props} class={styles.root} />,
	Label: (props: ArkField.LabelProps) => {
		const [local, rest] = splitProps(props, ["class"]);
		return <ArkField.Label {...rest} class={cx(styles.label, local.class)} />;
	},
	Input: (props: ArkField.InputProps) => <ArkField.Input {...props} class={styles.input} />,
	ErrorText: (props: ArkField.ErrorTextProps) => (
		<ArkField.ErrorText {...props} class={styles.errorText} />
	),
};
