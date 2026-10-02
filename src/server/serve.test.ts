import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { EngineRuntime } from "../core/engine.ts";
import { ENGINE_PREFIX } from "./router.ts";
import { startStandalone } from "./serve.ts";

let root = "";
let dist = "";
let server: { port: number; close: () => Promise<void> };
let outside = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omnium-serve-"));
  dist = path.join(root, "dist");
  outside = path.join(root, "secreto.txt");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Omnium</title>", "utf8");
  await writeFile(path.join(dist, "assets", "app.js"), "console.log(1)", "utf8");
  await writeFile(outside, "no debe salirse", "utf8");
  server = await startStandalone({ distDir: dist, port: 0, runtime: new EngineRuntime() });
});

after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;

test("sirve index.html en la raíz", async () => {
  const response = await fetch(`${base()}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /Omnium/);
});

test("sirve los assets con su tipo", async () => {
  const response = await fetch(`${base()}/assets/app.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await response.text(), "console.log(1)");
});

test("una ruta de SPA desconocida cae en index.html", async () => {
  const response = await fetch(`${base()}/pedidos/42`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Omnium/);
});

test("no se escapa del dist ni con dot-segments ni con %2e", async () => {
  for (const target of ["/../secreto.txt", "/assets/../../secreto.txt", "/%2e%2e/secreto.txt"]) {
    const response = await fetch(`${base()}${target}`);
    assert.equal(response.status, 200, target);
    const body = await response.text();
    assert.ok(!body.includes("no debe salirse"), `se sirvió contenido fuera de dist: ${target}`);
    assert.match(body, /Omnium/, target);
  }
});

test("el motor responde por HTTP en el servidor standalone", async () => {
  const response = await fetch(`${base()}${ENGINE_PREFIX}/cookies`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { cookies: unknown[] };
  assert.ok(Array.isArray(payload.cookies));
});

test("sin build responde 503 con la instrucción", async () => {
  const empty = await startStandalone({ distDir: path.join(root, "vacio"), port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${empty.port}/`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /build:renderer/);
  } finally {
    await empty.close();
  }
});

test("métodos que no son GET/HEAD responden 405", async () => {
  const response = await fetch(`${base()}/`, { method: "POST" });
  assert.equal(response.status, 405);
});
