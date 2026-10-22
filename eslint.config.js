import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "extension/dist", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  { files: ["extension/build.mjs"], languageOptions: { globals: { console: "readonly" } } },
);
