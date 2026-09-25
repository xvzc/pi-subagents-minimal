import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", ".specs/**", ".pi/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Carried over from the previous Biome setup, which disabled the same
    // three rules. Type safety is enforced by `tsc --noEmit` instead.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-control-regex": "off",
    },
  },
  prettierConfig,
);
