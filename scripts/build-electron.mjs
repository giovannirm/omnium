import * as esbuild from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist-electron", { recursive: true });

await esbuild.build({
  entryPoints: {
    main: "electron/main.ts",
    preload: "electron/preload.ts",
  },
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
