import { Field as ArkField } from "@ark-ui/solid";
import { sva } from "../../../styled-system/css";

// Ark UI Field (headless, accessible) styled with a Panda slot recipe (sva).
// Field.Root wires the input to its label/error via generated IDs (Solid
// createUniqueId → deterministic across SSR/hydrate), and sets aria-invalid +
// aria-describedby when `invalid` is set, so the error text is announced.
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
	// biome-ignore lint/style/useNamingConvention: Ark compound-component part name
	Root: (props: ArkField.RootProps) => <ArkField.Root {...props} class={styles.root} />,
	// biome-ignore lint/style/useNamingConvention: Ark compound-component part name
	Label: (props: ArkField.LabelProps) => <ArkField.Label {...props} class={styles.label} />,
	// biome-ignore lint/style/useNamingConvention: Ark compound-component part name
	Input: (props: ArkField.InputProps) => <ArkField.Input {...props} class={styles.input} />,
	// biome-ignore lint/style/useNamingConvention: Ark compound-component part name
	ErrorText: (props: ArkField.ErrorTextProps) => (
		<ArkField.ErrorText {...props} class={styles.errorText} />
	),
};
