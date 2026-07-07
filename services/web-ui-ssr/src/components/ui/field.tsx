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
			flexDirection: "column",
			gap: "0.25rem",
			flex: 1,
		},
		label: {
			color: "fg",
			fontSize: "0.875rem",
			fontWeight: 600,
		},
		input: {
			inlineSize: "100%",
			outline: "none",
			border: "1px solid {colors.border.input}",
			borderRadius: "0.375rem",
			padding: "0.5rem 0.75rem",
			fontSize: "1rem",
			_focus: {
				borderColor: "brand",
				boxShadow: "0 0 0 2px {colors.brand.focusRing}",
			},
		},
		errorText: {
			padding: "0.5rem 0",
			color: "danger",
			fontSize: "0.875rem",
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
