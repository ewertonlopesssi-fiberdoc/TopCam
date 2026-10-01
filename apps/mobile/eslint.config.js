// Lint do app (projeto à parte do monorepo).
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["dist/*", "android/*", "ios/*", ".expo/*", "scripts/*.mjs"] },
]);
