import * as esbuild from "esbuild";

// Self-contained server-plugin bundle: V1 needs `tool()` + zod at runtime, so
// both are inlined — the published package stays zero-dependency. Nothing is
// external: `@opencode-ai/plugin` is used only for the tiny identity `tool()`
// helper, and type-only imports are erased. Output overwrites tsc's
// dist/index.js (tests import the other dist/*.js modules, which stay).
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  bundle: true,
  minify: false,
});
