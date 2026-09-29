import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function startDemo(port = 4321): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "error" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const done = (status: number) => {
    console.log(`${req.method ?? "GET"} ${url.pathname} ${status}`);
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    res.end();
    done(204);
    return;
  }
  if (url.pathname === "/" && req.method === "GET") {
    const html = `<!doctype html><meta charset="utf-8"><title>Omnium demo</title>
<body style="font-family:sans-serif;background:#101210;color:#e7eee4;padding:32px">
<h1>Omnium demo</h1>
<p>El servidor está respondiendo.</p>
<ul>
<li><a href="/health">GET /health</a></li>
<li>POST /login</li>
<li>GET /me</li>
</ul>
<p>Abre <a href="/health">/health</a> para ver el JSON de prueba.</p>
</body>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors() });
    res.end(html);
    done(200);
    return;
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true, service: "omnium-demo" }, done);
  if (url.pathname === "/delay") {
    const ms = Math.min(2000, Math.max(0, Number(url.searchParams.get("ms") ?? 50)));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return send(res, 200, { waited: ms }, done);
  }
  if (url.pathname === "/login" && req.method === "POST") {
    const raw = await readBody(req);
    let user = "ada";
    try {
      const parsed = JSON.parse(raw) as { user?: string };
      if (parsed.user) user = parsed.user;
    } catch {
      user = "ada";
    }
    return send(res, 200, { token: `token-${user}`, user }, done);
  }
  if (url.pathname === "/me") {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token) return send(res, 401, { error: "falta el token" }, done);
    const user = token.startsWith("token-") ? token.slice("token-".length) : "ada";
    return send(res, 200, { user, role: "builder" }, done);
  }
  if (url.pathname === "/session" && req.method === "POST") {
    return send(res, 200, { ok: true }, done, { "set-cookie": "sid=abc123; Path=/" });
  }
  if (url.pathname === "/session" && req.method === "GET") {
    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes("sid=abc123")) return send(res, 401, { error: "sin sesion" }, done);
    return send(res, 200, { user: "ada" }, done);
  }
  return send(res, 404, { error: "no existe", prueba: "/health" }, done);
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  done: (status: number) => void = () => undefined,
  extra: Record<string, string> = {},
): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    ...cors(),
    ...extra,
  });
  res.end(raw);
  done(status);
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function ranDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function listenFrom(preferred: number): Promise<{ port: number; close: () => Promise<void> }> {
  for (let port = preferred; port < preferred + 20; port += 1) {
    try {
      return await startDemo(port);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") continue;
      throw error;
    }
  }
  throw new Error(`No hay un puerto libre entre ${preferred} y ${preferred + 19}`);
}

if (ranDirectly()) {
  const preferred = Number(process.env.PORT) || 4321;
  listenFrom(preferred)
    .then(({ port }) => {
      console.log(`Omnium demo en http://127.0.0.1:${port}/`);
      if (port !== preferred) {
        console.log(`El puerto ${preferred} ya lo usa otro programa.`);
        console.log(`En Omnium, pon baseUrl en http://127.0.0.1:${port}`);
      }
      console.log("  GET  /health");
      console.log("  POST /login");
      console.log("  GET  /me");
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
