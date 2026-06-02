module.exports = {
  extends: [
    "eslint:recommended",
    "prettier",
    "plugin:@typescript-eslint/recommended",
  ],
  parserOptions: {
    ecmaVersion: 12,
    parser: "@typescript-eslint/parser",
    project: "./tsconfig.json",
    sourceType: "module",
  },
  plugins: ["import", "@typescript-eslint", "no-instanceof"],
  ignorePatterns: [
    ".eslintrc.cjs",
    "scripts",
    "src/utils/lodash/*",
    "node_modules",
    "dist",
    "dist-cjs",
    "*.js",
    "*.cjs",
    "*.d.ts",
  ],
  rules: {},
};
