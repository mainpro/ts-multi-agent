import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  clean: true,
  target: "node20",
  format: ["cjs"],
  noExternal: [/^.*/],
});
