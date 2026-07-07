import { defineConfig } from "@pandacss/dev";

export default defineConfig({
	preflight: true,
	include: ["./src/**/*.{ts,tsx}"],
	outdir: "styled-system",
	theme: {
		extend: {
			// Semantic color palette. Every value is the exact hex previously
			// hardcoded across src/pages/*.styles.ts, now exposed as a named token
			// so components reference tokens (not raw hex) and @pandacss/no-hardcoded-color
			// stays clean. Values are unchanged, so the rendered output is identical.
			tokens: {
				colors: {
					brand: {
						// biome-ignore lint/style/useNamingConvention: Panda's DEFAULT key maps the value to the token's parent path (e.g. `brand`)
						DEFAULT: { value: "#2563eb" },
						contrast: { value: "#ffffff" },
						// Focus ring uses the brand hue at 20% alpha (was an inline rgba).
						focusRing: { value: "rgba(37, 99, 235, 0.2)" },
					},
					fg: {
						// biome-ignore lint/style/useNamingConvention: Panda's DEFAULT key maps the value to the token's parent path (e.g. `fg`)
						DEFAULT: { value: "#1f2937" },
						muted: { value: "#6b7280" },
						subtle: { value: "#9ca3af" },
					},
					danger: {
						// biome-ignore lint/style/useNamingConvention: Panda's DEFAULT key maps the value to the token's parent path (e.g. `danger`)
						DEFAULT: { value: "#ef4444" },
					},
					border: {
						// biome-ignore lint/style/useNamingConvention: Panda's DEFAULT key maps the value to the token's parent path (e.g. `border`)
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
						gap: "0.375rem",
						borderRadius: "0.375rem",
						fontWeight: 600,
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
								borderRadius: "0.25rem",
								padding: "0.25rem 0.5rem",
								fontSize: "0.75rem",
							},
							md: {
								padding: "0.5rem 1rem",
								fontSize: "1rem",
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
