import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineRuntime } from "../core/engine.ts";
import { handleEngineRequest } from "./router.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export type StandaloneOptions = {
  distDir: string;
  port?: number;
  host?: string;
  runtime?: EngineRuntime;
};

/**
 * Servidor standalone: sirve el build de `dist/` y las rutas del motor.
 * Es la misma fórmula que usa Electron en producción, sin Electron.
 */
export async function startStandalone(
  options: StandaloneOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const runtime = options.runtime ?? new EngineRuntime();
  const distDir = path.resolve(options.distDir);
  const server = createServer((req, res) => {
    void handle(req, res, distDir, runtime).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Error interno" }));
    });
  });
  return listen(server, options.port ?? 4173, options.host ?? "127.0.0.1");
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
  runtime: EngineRuntime,
): Promise<void> {
  if (await handleEngineRequest(runtime, req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Método no permitido" }));
    return;
  }
  await serveStatic(req, res, distDir);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string): Promise<void> {
  const requested = safePath(distDir, req.url ?? "/");
  const file = await existing(requested);
  const target = file ?? path.join(distDir, "index.html");
  if (!file && !(await exists(target))) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Falta el build de la interfaz. Ejecuta `npm run build:renderer` y vuelve a intentar.");
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.byteLength,
    "cache-control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** Resuelve dentro de distDir; cualquier fuga de directorio cae en index.html. */
function safePath(distDir: string, rawUrl: string): string {
  const pathname = decodeURI(new URL(rawUrl, "http://127.0.0.1").pathname);
  const resolved = path.resolve(distDir, `.${path.posix.normalize(pathname)}`);
  return resolved.startsWith(distDir) ? resolved : path.join(distDir, "index.html");
}

async function existing(candidate: string): Promise<string | null> {
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return existing(path.join(candidate, "index.html"));
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function exists(candidate: string): Promise<boolean> {
  return (await existing(candidate)) !== null;
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const live = typeof address === "object" && address ? address.port : port;
      resolve({
        port: live,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function ranDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (ranDirectly()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = process.env.OMNIUM_DIST ?? path.resolve(here, "../../dist");
  const port = Number(process.env.PORT) || 4173;
  startStandalone({ distDir, port })
    .then(({ port: live }) => {
      console.log(`Omnium en http://127.0.0.1:${live}/`);
      console.log(`  dist: ${distDir}`);
      console.log("  rutas del motor: /__omnium/*");
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
