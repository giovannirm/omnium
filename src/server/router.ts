import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineRuntime } from "../core/engine.ts";
import type { ExecutePayload, LoadPayload, RunPayload } from "../core/types.ts";

export const ENGINE_PREFIX = "/__omnium";

/**
 * Router del motor compartido por todos los hosts HTTP: el middleware de Vite
 * (dev) y el servidor estático (standalone) delegan acá. Devuelve `true` si la
 * petición le pertenecía, aunque haya respondido con un 404 de ruta.
 */
export async function handleEngineRequest(
  runtime: EngineRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(ENGINE_PREFIX)) return false;
  try {
    await route(runtime, url, req, res);
  } catch (error: unknown) {
    if (res.writableEnded || res.destroyed) return true;
    json(res, statusFor(error), { error: message(error) });
  }
  return true;
}

async function route(
  runtime: EngineRuntime,
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (url === `${ENGINE_PREFIX}/cookies` && req.method === "GET") {
    json(res, 200, { cookies: runtime.listCookies() });
    return;
  }
  if (url === `${ENGINE_PREFIX}/cookies/clear` && req.method === "POST") {
    runtime.clearCookies();
    json(res, 200, { ok: true });
    return;
  }
  if (url === `${ENGINE_PREFIX}/load/stop` && req.method === "POST") {
    runtime.stopLoad();
    json(res, 200, { ok: true });
    return;
  }
  if (url === `${ENGINE_PREFIX}/execute` && req.method === "POST") {
    const signal = tieAbort(res);
    const payload = (await readJson(req)) as ExecutePayload;
    if (signal.aborted || res.writableEnded) return;
    json(res, 200, await runtime.execute(payload, signal));
    return;
  }
  if (url === `${ENGINE_PREFIX}/run` && req.method === "POST") {
    const signal = tieAbort(res);
    const payload = (await readJson(req)) as RunPayload;
    if (signal.aborted || res.writableEnded) return;
    json(res, 200, await runtime.run(payload, signal));
    return;
  }
  if (url === `${ENGINE_PREFIX}/load` && req.method === "POST") {
    const signal = tieAbort(res);
    const payload = (await readJson(req)) as LoadPayload;
    if (signal.aborted || res.writableEnded) return;
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
    const snap = await runtime.startLoad(payload, {
      onTick: (tick) => {
        if (!res.destroyed) res.write(`${JSON.stringify({ type: "tick", snap: tick })}\n`);
      },
    });
    if (res.destroyed) return;
    res.write(`${JSON.stringify({ type: "done", snap })}\n`);
    res.end();
    return;
  }
  json(res, 404, { error: "Ruta no encontrada" });
}

/** El cierre de la conexión corta la operación en vuelo, como antes. */
function tieAbort(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

function statusFor(error: unknown): number {
  return error instanceof Error && /incompleta/.test(error.message) ? 400 : 500;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Error interno";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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
