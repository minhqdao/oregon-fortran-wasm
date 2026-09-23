// @ts-check
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    // Generated output, never hand-written source: the committed
    // Emscripten glue and the local build/deploy directories.
    ignores: ["web/oregon.js", "dist/", "build/"],
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
