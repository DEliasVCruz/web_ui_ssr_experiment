import { ark } from "@ark-ui/solid/factory";
import type { ComponentProps } from "solid-js";
import { splitProps } from "solid-js";
import { cx } from "../../../styled-system/css";
import { type ButtonVariantProps, button } from "../../../styled-system/recipes";

// The reference Ark UI + Panda component (ol9.1): Ark's headless `ark.button`
// factory (polymorphic, forwards refs/ARIA/`asChild`) styled by the Panda
// `button` recipe defined in panda.config.ts. No client-only APIs run during
// render, so it is SSR-safe and hydrates deterministically.
export interface ButtonProps extends ComponentProps<typeof ark.button>, ButtonVariantProps {}

export function Button(props: ButtonProps) {
	const [variantProps, rest] = button.splitVariantProps(props);
	const [local, arkProps] = splitProps(rest, ["class"]);
	return <ark.button {...arkProps} class={cx(button(variantProps), local.class)} />;
}
