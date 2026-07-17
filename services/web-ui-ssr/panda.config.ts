import { defineConfig } from "@pandacss/dev";

export default defineConfig({
	preflight: true,
	include: ["./src/**/*.{ts,tsx}"],
	outdir: "styled-system",
	// Uncompilable beats lintable: raw hex/px/arbitrary values become TYPE
	// ERRORS, not lint warnings. strictTokens forces token-only values on
	// properties that have a token category (colors, spacing, fontSizes, …);
	// strictPropertyValues forces the constrained keyword set on properties
	// like display/position that have no token category. The bracket escape
	// `[...]` is additionally sealed by @pandacss/no-escape-hatch (eslint).
	strictTokens: true,
	strictPropertyValues: true,
	theme: {
		extend: {
			// Semantic color palette. Every value is the exact hex previously
			// hardcoded across src/pages/*.styles.ts, now exposed as a named token
			// so components reference tokens (not raw hex) and @pandacss/no-hardcoded-color
			// stays clean. Values are unchanged, so the rendered output is identical.
			tokens: {
				colors: {
					brand: {
						DEFAULT: { value: "#2563eb" },
						contrast: { value: "#ffffff" },
						// Focus ring uses the brand hue at 20% alpha (was an inline rgba).
						focusRing: { value: "rgba(37, 99, 235, 0.2)" },
					},
					fg: {
						DEFAULT: { value: "#1f2937" },
						muted: { value: "#6b7280" },
						subtle: { value: "#9ca3af" },
					},
					danger: {
						DEFAULT: { value: "#ef4444" },
					},
					border: {
						DEFAULT: { value: "#e5e7eb" },
						input: { value: "#d1d5db" },
					},
					success: {
						fg: { value: "#065f46" },
						bg: { value: "#d1fae5" },
					},
					warning: {
						fg: { value: "#92400e" },
						bg: { value: "#fef3c7" },
					},
					// Surface + scrim for overlay UI (Dialog, Toast) added in ol9.4/ol9.5.
					surface: { value: "#ffffff" },
					overlay: { value: "rgba(0, 0, 0, 0.4)" },
				},
				// Two display type sizes that sit off Panda's default t-shirt
				// fontSize scale (which has no 2rem/1.75rem step). `heading` is the
				// top-level page H1 (todos list); `title` is the detail-page H1.
				// Every other font size in the app maps onto the default xs/sm/md/xl
				// tokens, so these are the only bespoke type tokens.
				fontSizes: {
					title: { value: "1.75rem" },
					heading: { value: "2rem" },
				},
				// Named layout widths. These are component-role widths, not steps on
				// the generic sizes scale, so they get semantic names (mirroring the
				// semantic color tokens above) instead of obscure numeric/t-shirt keys.
				sizes: {
					container: { value: "48rem" }, // page content column max width
					dialog: { value: "24rem" }, // modal content max width
					toastMin: { value: "15rem" }, // toast min width
					toastMax: { value: "22rem" }, // toast max width
					field: { value: "8rem" }, // multi-line field (details textarea) min height
				},
				// Elevation + focus-ring shadows, previously inline box-shadow strings.
				// `focusRing` composes the brand.focusRing color token.
				shadows: {
					dialog: { value: "0 10px 25px rgba(0, 0, 0, 0.15)" },
					toast: { value: "0 6px 18px rgba(0, 0, 0, 0.15)" },
					focusRing: { value: "0 0 0 2px {colors.brand.focusRing}" },
				},
				// Composite border tokens so components keep the `border` shorthand
				// (satisfying prefer-shorthand-properties) while still being fully
				// token-driven (satisfying strictTokens). Each composes a color token.
				borders: {
					control: { value: "1px solid {colors.border.input}" }, // inputs, checkbox control
					divider: { value: "1px solid {colors.border}" }, // list-row separator
					accent: { value: "4px solid {colors.border}" }, // toast start accent
				},
			},
			// Reference recipe for the Ark UI + Panda component pattern (ol9.1).
			// Consumed by src/components/ui/button.tsx, which wraps Ark's headless
			// `ark.button` factory and applies this recipe's class.
			recipes: {
				button: {
					className: "ui-button",
					description: "Ark UI button styled with a Panda recipe",
					base: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						gap: "1.5",
						borderRadius: "md",
						fontWeight: "semibold",
						// Unitless ratio with no matching lineHeights token; kept literal.
						lineHeight: 1.2,
						cursor: "pointer",
						_disabled: {
							opacity: 0.5,
							cursor: "default",
						},
					},
					variants: {
						variant: {
							solid: {
								border: "none",
								backgroundColor: "brand",
								color: "brand.contrast",
							},
							outline: {
								borderWidth: "1px",
								borderStyle: "solid",
								borderColor: "danger",
								backgroundColor: "transparent",
								color: "danger",
							},
							dangerSolid: {
								border: "none",
								backgroundColor: "danger",
								color: "brand.contrast",
							},
							ghost: {
								border: "none",
								backgroundColor: "transparent",
								color: "fg.muted",
							},
						},
						size: {
							sm: {
								borderRadius: "sm",
								paddingBlock: "1",
								paddingInline: "2",
								fontSize: "xs",
							},
							md: {
								paddingBlock: "2",
								paddingInline: "4",
								fontSize: "md",
							},
						},
					},
					defaultVariants: {
						variant: "solid",
						size: "md",
					},
				},
			},
		},
	},
});
