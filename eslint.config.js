import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/coverage/**", "**/node_modules/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // フロントエンド: XSS 対策として dangerouslySetInnerHTML を禁止（docs/security.md）
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML は禁止です（docs/security.md）。",
        },
      ],
    },
  },
  {
    // SQL Injection 対策: 生 SQL の Unsafe API を禁止
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "$queryRawUnsafe", message: "$queryRaw のタグ付きテンプレートを使ってください。" },
        { property: "$executeRawUnsafe", message: "$executeRaw のタグ付きテンプレートを使ってください。" },
      ],
    },
  },
  {
    // SNS 最適化レイヤーは外部 I/O を持たない（docs/architecture.md のレイヤー規則）
    files: ["packages/platforms/src/**/*.ts", "packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@aya/providers",
                "@aya/db",
                "@aya/queue",
                "node:fs",
                "node:child_process",
                "node:http",
                "node:https",
              ],
              message: "このパッケージは純粋関数に保ちます（外部 I/O 禁止）。",
            },
          ],
        },
      ],
    },
  },
);
