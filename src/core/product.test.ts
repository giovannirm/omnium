import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "./cookies.ts";
import { prepareRequest, readLimitedBody } from "./execute.ts";
import { createRequest, pair } from "./factory.ts";
import { judgeLoad } from "./load.ts";
import { exportPostman, importPostman } from "./postman.ts";
import { toFetch } from "./snippets.ts";
import { sampleWorkspace } from "./sample.ts";
import { resolveVariables } from "./variables.ts";

test("importa una colección de Postman con carpeta, auth y variables", () => {
  const collection = importPostman({
    info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "base", value: "https://tienda.test" }],
    item: [
      {
        name: "Cuenta",
        item: [
          {
            name: "Entrar",
            request: {
              method: "POST",
              url: "{{base}}/login",
              header: [{ key: "Accept", value: "application/json" }],
              auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
              body: { mode: "raw", raw: "{\"user\":\"ada\"}", options: { raw: { language: "json" } } },
            },
          },
        ],
      },
    ],
  });
  assert.equal(collection.name, "Tienda");
  assert.equal(collection.variables[0]?.key, "base");
  assert.equal(collection.requests[0]?.name, "Cuenta / Entrar");
  assert.equal(collection.requests[0]?.method, "POST");
  assert.equal(collection.requests[0]?.auth.type, "bearer");
  assert.equal(collection.requests[0]?.bodyMode, "json");
  const exported = exportPostman(collection) as { item: { name: string }[] };
  assert.equal(exported.item[0]?.name, "Cuenta / Entrar");
});

test("las variables de colección pisan al ambiente y la corrida pisa a todas", () => {
  const workspace = sampleWorkspace();
  const resolved = resolveVariables(workspace.environments[0] ?? null, { token: "vivo" }, {
    globals: [{ id: "g", key: "baseUrl", value: "https://global", enabled: true }],
    collection: [{ id: "c", key: "baseUrl", value: "https://coleccion", enabled: true }],
  });
  assert.equal(resolved.baseUrl, "https://coleccion");
  assert.equal(resolved.token, "vivo");
});

test("la carga falla si el percentil o los errores se pasan del límite", () => {
  const snap = {
    elapsedMs: 1000,
    inflight: 0,
    sent: 10,
    ok: 8,
    failed: 2,
    rps: 10,
    avgMs: 40,
    minMs: 10,
    maxMs: 90,
    p50: 30,
    p95: 80,
    p99: 90,
    errors: [],
    samplesCapped: false,
    stopped: false,
  };
  assert.equal(judgeLoad(snap, { concurrency: 2, rampUpMs: 0, durationMs: 1000, timeoutMs: 1000, pauseMs: 0, maxErrorPct: 5, maxP95Ms: 50 }).passed, false);
  assert.equal(judgeLoad(snap, { concurrency: 2, rampUpMs: 0, durationMs: 1000, timeoutMs: 1000, pauseMs: 0, maxErrorPct: 25, maxP95Ms: 100 }).passed, true);
});

test("no envía si falta una variable de la petición", () => {
  const prepared = prepareRequest(createRequest({ url: "https://api.test/{{id}}", description: "{{nota}}" }), {});
  assert.match(prepared.error ?? "", /id/);
  assert.doesNotMatch(prepared.error ?? "", /nota/);
});

test("rechaza esquemas que no son http", () => {
  const prepared = prepareRequest(createRequest({ url: "file:///tmp/secreto" }), {});
  assert.match(prepared.error ?? "", /http y https/);
});

test("limpia saltos de línea en cabeceras", () => {
  const prepared = prepareRequest(
    createRequest({
      url: "https://api.test/item",
      headers: [pair("X-Test", "uno\r\nX-Injected: dos")],
    }),
    {},
  );
  assert.equal(prepared.headers.find(([key]) => key.toLowerCase() === "x-test")?.[1], "unoX-Injected: dos");
  assert.equal(prepared.headers.some(([key]) => key.toLowerCase() === "x-injected"), false);
});

test("recorta un cuerpo grande y conserva uno corto", async () => {
  const chunk = new Uint8Array(1000).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 4; index += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  const limited = await readLimitedBody(new Response(stream), 2500);
  assert.equal(limited.truncated, true);
  assert.equal(limited.buffer.byteLength, 2500);
  const short = await readLimitedBody(new Response("hola"), 100);
  assert.equal(short.truncated, false);
  assert.equal(new TextDecoder().decode(short.buffer), "hola");
});

test("las cookies respetan camino, dominio, caducidad y https", () => {
  const jar = new CookieJar();
  const now = 1_700_000_000_000;
  jar.absorb(new URL("https://api.example.test/v1/login"), ["sid=abc; Domain=example.test; Path=/; Secure"]);
  assert.equal(jar.headerFor(new URL("https://api.example.test/v1/me")), "sid=abc");
  assert.equal(jar.headerFor(new URL("https://example.test/")), "sid=abc");
  assert.equal(jar.headerFor(new URL("http://api.example.test/")), null);
  assert.equal(jar.headerFor(new URL("https://notexample.test/")), null);

  const host = new CookieJar();
  host.absorb(new URL("http://app.test/admin/home"), ["a=1"]);
  assert.equal(host.headerFor(new URL("http://app.test/admin/users")), "a=1");
  assert.equal(host.headerFor(new URL("http://app.test/")), null);
  assert.equal(host.headerFor(new URL("http://www.app.test/admin/users")), null);

  const rejected = new CookieJar();
  rejected.absorb(new URL("http://app.test/"), ["a=1; Domain=evil.test"]);
  assert.equal(rejected.list().length, 0);

  const timed = new CookieJar();
  timed.absorb(new URL("http://app.test/"), ["stay=1; Path=/; Max-Age=10"], now);
  assert.equal(timed.headerFor(new URL("http://app.test/"), now + 9_000), "stay=1");
  assert.equal(timed.headerFor(new URL("http://app.test/"), now + 10_000), null);

  const local = new CookieJar();
  local.absorb(new URL("http://127.0.0.1/session"), ["sid=abc; Domain=evil.test; Path=/"]);
  assert.equal(local.headerFor(new URL("http://127.0.0.1/session")), "sid=abc");
  const copy = local.clone();
  local.clear();
  assert.equal(copy.headerFor(new URL("http://127.0.0.1/session")), "sid=abc");
  assert.equal(local.headerFor(new URL("http://127.0.0.1/session")), null);
});

test("genera fetch con el método y la url resuelta", () => {
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta");
  const code = toFetch(request, { baseUrl: "http://127.0.0.1:4321" });
  assert.match(code, /fetch\("http:\/\/127\.0\.0\.1:4321\/health"/);
  assert.match(code, /"GET"/);
});
