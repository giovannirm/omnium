import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { EngineRuntime } from "./src/core/engine.ts";
import { handleEngineRequest } from "./src/server/router.ts";

/**
 * En dev el motor se sirve desde el middleware de Vite, delegando en el router
 * compartido: la misma implementación que usa el servidor standalone y Electron.
 */
function omniumApi(): Plugin {
  const runtime = new EngineRuntime();
  return {
    name: "omnium-api",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        void handleEngineRequest(runtime, req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error: unknown) => {
            if (res.writableEnded || res.destroyed) return;
            const message = error instanceof Error ? error.message : "Error interno";
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: message }));
          });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), omniumApi()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
