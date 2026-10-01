import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { EngineRuntime } from "../core/engine.ts";
import { sampleWorkspace } from "../core/sample.ts";
import { startDemo } from "../demo/server.ts";
import { ENGINE_PREFIX, handleEngineRequest } from "./router.ts";

let demo: { port: number; close: () => Promise<void> };
let site: { port: number; close: () => Promise<void> };
const runtime = new EngineRuntime();

before(async () => {
  demo = await startDemo(0);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleEngineRequest(runtime, req, res).then((handled) => {
      if (handled || res.writableEnded) return;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("sin motor");
    });
  });
  site = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
});

after(async () => {
  await demo.close();
  await site.close();
});

const base = () => `http://127.0.0.1:${site.port}`;

test("el router ejecuta peticiones y comparte cookies", async () => {
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta la petición");
  const opened = await fetch(`${base()}${ENGINE_PREFIX}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { ...request, url: `http://127.0.0.1:${demo.port}/session`, method: "POST", assertions: [], bodyMode: "none" },
      variables: {},
    }),
  });
  assert.equal(opened.status, 200);
  const cookies = (await (await fetch(`${base()}${ENGINE_PREFIX}/cookies`)).json()) as { cookies: unknown[] };
  assert.ok(cookies.cookies.length > 0);

  const read = await fetch(`${base()}${ENGINE_PREFIX}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { ...request, url: `http://127.0.0.1:${demo.port}/session`, method: "GET", assertions: [] },
      variables: {},
    }),
  });
  const payload = (await read.json()) as { status: number };
  assert.equal(payload.status, 200);

  const cleared = await fetch(`${base()}${ENGINE_PREFIX}/cookies/clear`, { method: "POST" });
  assert.equal(cleared.status, 200);
  const after = (await (await fetch(`${base()}${ENGINE_PREFIX}/cookies`)).json()) as { cookies: unknown[] };
  assert.equal(after.cookies.length, 0);
});

test("una petición incompleta responde 400", async () => {
  const response = await fetch(`${base()}${ENGINE_PREFIX}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variables: {} }),
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /incompleta/);
});

test("las rutas fuera del prefijo no las toca el router", async () => {
  const response = await fetch(`${base()}/otra`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "sin motor");
});

test("el prefijo sin ruta conocida responde 404", async () => {
  const response = await fetch(`${base()}${ENGINE_PREFIX}/nada`);
  assert.equal(response.status, 404);
});
