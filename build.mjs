import * as esbuild from "esbuild";

// Self-contained server-plugin bundle: zero runtime deps — type-only imports
// (`@opencode-ai/plugin`, zod) are erased, so nothing is inlined or external.
// Output overwrites tsc's dist/index.js (tests import the other dist/*.js
// modules, which stay).
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  bundle: true,
  minify: false,
});
