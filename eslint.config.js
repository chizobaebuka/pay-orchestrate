const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "coverage/**", "public/**"],
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            // Provider payloads, TypeORM query results, and job data are handled as
            // `any`/`unknown` at several intentional boundaries in this codebase (raw
            // webhook bodies, third-party API responses) — not worth fighting here.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        },
    }
);
