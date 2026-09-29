import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { executeRequest } from "./src/core/execute.ts";
import { clampPlan, runLoad } from "./src/core/load.ts";
import { runCollection } from "./src/core/runner.ts";
import { sessionJar } from "./src/core/session.ts";
import type { ExecutePayload, LoadPayload, RunPayload } from "./src/core/types.ts";

function omniumApi(): Plugin {
  let active: AbortController | null = null;
  return {
    name: "omnium-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__omnium")) {
          next();
          return;
        }
        void route(url, req, res).catch((error: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          const message = error instanceof Error ? error.message : "Error interno";
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: message }));
        });
      });
    },
  };

  async function route(url: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (url === "/__omnium/cookies" && req.method === "GET") {
      json(res, 200, { cookies: sessionJar.list() });
      return;
    }
    if (url === "/__omnium/cookies/clear" && req.method === "POST") {
      sessionJar.clear();
      json(res, 200, { ok: true });
      return;
    }
    if (url === "/__omnium/load/stop" && req.method === "POST") {
      active?.abort();
      json(res, 200, { ok: true });
      return;
    }
    if (url === "/__omnium/execute" && req.method === "POST") {
      const controller = tieAbort(res);
      const payload = (await readJson(req)) as ExecutePayload;
      if (controller.signal.aborted || res.writableEnded) return;
      if (!payload?.request) {
        json(res, 400, { error: "La petición está incompleta" });
        return;
      }
      const result = await executeRequest({
        request: payload.request,
        variables: payload.variables ?? {},
        jar: sessionJar,
        signal: controller.signal,
      });
      if (!res.writableEnded) json(res, 200, result);
      return;
    }
    if (url === "/__omnium/run" && req.method === "POST") {
      const controller = tieAbort(res);
      const payload = (await readJson(req)) as RunPayload;
      if (controller.signal.aborted || res.writableEnded) return;
      if (!payload?.requests) {
        json(res, 400, { error: "La colección está incompleta" });
        return;
      }
      const result = await runCollection({
        requests: payload.requests,
        variables: payload.variables ?? {},
        jar: sessionJar,
        signal: controller.signal,
      });
      if (!res.writableEnded) json(res, 200, result);
      return;
    }
    if (url === "/__omnium/load" && req.method === "POST") {
      active?.abort();
      const controller = tieAbort(res);
      active = controller;
      const payload = (await readJson(req)) as LoadPayload;
      if (controller.signal.aborted || res.writableEnded) return;
      if (!payload?.request) {
        json(res, 400, { error: "La carga está incompleta" });
        return;
      }
      const frozen = sessionJar.clone();
      const plan = clampPlan(payload.plan);
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
      const snap = await runLoad({
        plan,
        signal: controller.signal,
        onTick: (tick) => {
          if (!res.destroyed) res.write(`${JSON.stringify({ type: "tick", snap: tick })}\n`);
        },
        runOnce: async (signal) => {
          const result = await executeRequest({
            request: { ...payload.request, timeoutMs: plan.timeoutMs },
            variables: payload.variables,
            jar: frozen,
            persistCookies: false,
            captureBody: false,
            signal,
          });
          return {
            ok: !result.error && result.status !== null && result.status < 400,
            timeMs: result.timeMs,
            status: result.status,
            error: result.error,
          };
        },
      });
      if (res.destroyed) return;
      res.write(`${JSON.stringify({ type: "done", snap })}\n`);
      res.end();
      return;
    }
    json(res, 404, { error: "Ruta no encontrada" });
  }
}

function tieAbort(res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(raw);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error("La petición es demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("JSON no válido"));
      }
    });
    req.on("error", reject);
  });
}

export default defineConfig({
  base: "./",
  plugins: [react(), omniumApi()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
