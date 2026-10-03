import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { stepPassed } from "./assertions.ts";
import { CookieJar } from "./cookies.ts";
import { parseCurl } from "./curl.ts";
import { loadFromDir, saveToDir } from "../host/disk.ts";
import { EngineRuntime } from "./engine.ts";
import { executeRequest, toCurl } from "./execute.ts";
import { filesToWorkspace, workspaceToFiles } from "./files.ts";
import { lookup } from "./jsonpath.ts";
import { clampPlan, runLoad } from "./load.ts";
import { runCollection } from "./runner.ts";
import { sampleWorkspace } from "./sample.ts";
import { interpolate } from "./variables.ts";
import { startDemo } from "../demo/server.ts";

let demo: { port: number; close: () => Promise<void> };

before(async () => {
  demo = await startDemo(0);
});

after(async () => {
  await demo.close();
});

test("interpola variables y deja las que faltan", () => {
  assert.equal(interpolate("{{baseUrl}}/{{name}}", { baseUrl: "http://local", name: "ada" }), "http://local/ada");
  assert.equal(interpolate("{{missing}}", {}), "{{missing}}");
});

test("lee rutas json", () => {
  const value = { ok: true, items: [{ id: "a" }] };
  assert.equal(lookup(value, "$.ok").value, true);
  assert.equal(lookup(value, "items[0].id").value, "a");
  assert.equal(lookup(value, "$.nope").found, false);
});

test("el área de ejemplo sobrevive el viaje a archivos", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "omnium-"));
  try {
    const original = sampleWorkspace();
    await saveToDir(dir, original);
    const loaded = await loadFromDir(dir);
    assert.equal(loaded.name, "Omnium");
    assert.equal(loaded.collections[0]?.requests[1]?.extractors[0]?.name, "token");
    assert.deepEqual(filesToWorkspace(workspaceToFiles(original)).collections[0]?.requests.map((item) => item.id), [
      "req-health",
      "req-login",
      "req-me",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entiende un curl", () => {
  const parsed = parseCurl(`curl -X POST https://example.test/login -H 'Accept: application/json' -d '{"user":"ada"}'`);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, "https://example.test/login");
  assert.equal(parsed.bodyMode, "json");
  assert.equal(parsed.headers?.[0]?.key, "Accept");
});

test("la colección de ejemplo entra, extrae el token y lee el perfil", async () => {
  const workspace = sampleWorkspace();
  const base = `http://127.0.0.1:${demo.port}`;
  const report = await runCollection({
    requests: workspace.collections[0]?.requests ?? [],
    variables: { baseUrl: base },
  });
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 3);
  assert.equal(report.variables.token, "token-ada");
  assert.equal(report.steps.every((step) => stepPassed(step.result)), true);
});

test("las cookies de una respuesta viajan a la siguiente", async () => {
  const jar = new CookieJar();
  const base = `http://127.0.0.1:${demo.port}`;
  const login = sampleWorkspace().collections[0]?.requests[0];
  if (!login) throw new Error("falta la petición");
  const opened = await executeRequest({
    request: { ...login, url: `${base}/session`, method: "POST", assertions: [], bodyMode: "none" },
    variables: {},
    jar,
  });
  assert.equal(opened.status, 200);
  const read = await executeRequest({
    request: { ...login, url: `${base}/session`, method: "GET", assertions: [] },
    variables: {},
    jar,
  });
  assert.equal(read.status, 200);
  assert.equal((read.bodyJson as { user: string }).user, "ada");
});

test("la carga mide respuestas buenas y recorta el plan", async () => {
  const plan = clampPlan({ concurrency: 500, rampUpMs: 0, durationMs: 700, timeoutMs: 2000, pauseMs: 0, maxErrorPct: 5, maxP95Ms: 0 });
  assert.equal(plan.concurrency, 100);
  const workspace = sampleWorkspace();
  const request = workspace.collections[0]?.requests[0];
  if (!request) throw new Error("falta la petición");
  const target = { ...request, url: `http://127.0.0.1:${demo.port}/health`, assertions: [] };
  const snap = await runLoad({
    plan: { concurrency: 4, rampUpMs: 0, durationMs: 600, timeoutMs: 2000, pauseMs: 0, maxErrorPct: 5, maxP95Ms: 0 },
    signal: new AbortController().signal,
    runOnce: async (signal) => {
      const result = await executeRequest({ request: target, variables: {}, signal });
      return { ok: result.status !== null && result.status < 400 && !result.error, timeMs: result.timeMs, status: result.status, error: result.error };
    },
  });
  assert.ok(snap.ok > 0);
  assert.equal(snap.failed, 0);
});

test("una señal cancelada no se cuenta como tiempo agotado", async () => {
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta");
  const controller = new AbortController();
  controller.abort();
  const result = await executeRequest({
    request: { ...request, url: `http://127.0.0.1:${demo.port}/health`, assertions: [] },
    variables: {},
    signal: controller.signal,
  });
  assert.equal(result.error, "Petición cancelada");
});

test("puede medir una respuesta sin guardar el cuerpo", async () => {
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta");
  const result = await executeRequest({
    request: { ...request, url: `http://127.0.0.1:${demo.port}/health`, assertions: [] },
    variables: {},
    captureBody: false,
  });
  assert.equal(result.status, 200);
  assert.equal(result.bodyText, "");
  assert.equal(result.truncated, false);
});

test("exporta curl con la url ya resuelta", () => {
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta la petición");
  const curl = toCurl(request, { baseUrl: "http://127.0.0.1:4321" });
  assert.match(curl, /http:\/\/127\.0\.0\.1:4321\/health/);
});

test("el runtime comparte cookies entre ejecuciones y las limpia", async () => {
  const runtime = new EngineRuntime();
  const base = `http://127.0.0.1:${demo.port}`;
  const opened = await runtime.execute({
    request: {
      ...sampleWorkspace().collections[0]!.requests[0]!,
      url: `${base}/session`,
      method: "POST",
      assertions: [],
      bodyMode: "none",
    },
    variables: {},
  });
  assert.equal(opened.status, 200);
  assert.equal(runtime.listCookies().length > 0, true);
  const read = await runtime.execute({
    request: {
      ...sampleWorkspace().collections[0]!.requests[0]!,
      url: `${base}/session`,
      method: "GET",
      assertions: [],
    },
    variables: {},
  });
  assert.equal(read.status, 200);
  runtime.clearCookies();
  assert.equal(runtime.listCookies().length, 0);
});

test("cancelHttp corta una petición en vuelo", async () => {
  const runtime = new EngineRuntime();
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta la petición");
  const pending = runtime.execute({
    request: { ...request, url: `http://127.0.0.1:${demo.port}/delay?ms=1500`, assertions: [] },
    variables: {},
  });
  setTimeout(() => runtime.cancelHttp(), 50);
  const result = await pending;
  assert.equal(result.error, "Petición cancelada");
});

test("stopLoad corta una carga y devuelve stopped", async () => {
  const runtime = new EngineRuntime();
  const request = sampleWorkspace().collections[0]?.requests[0];
  if (!request) throw new Error("falta la petición");
  const pending = runtime.startLoad({
    request: { ...request, url: `http://127.0.0.1:${demo.port}/health`, assertions: [] },
    variables: {},
    plan: { concurrency: 2, rampUpMs: 0, durationMs: 4000, timeoutMs: 2000, pauseMs: 0, maxErrorPct: 5, maxP95Ms: 0 },
  });
  setTimeout(() => runtime.stopLoad(), 250);
  const snap = await pending;
  assert.equal(snap.stopped, true);
  assert.ok(snap.elapsedMs < 3000);
  assert.ok(snap.sent > 0);
  assert.equal(snap.failed, 0);
});

test("los hooks pre/post orquestan scripts, ambiente y logs", async () => {
  const request = { ...sampleWorkspace().collections[0]!.requests[0]! };
  const result = await executeRequest({
    request,
    variables: { baseUrl: `http://127.0.0.1:${demo.port}` },
    scripts: {
      pre: [{ label: "ambiente", code: 'omnium.env.set("marca", "hoy");' }],
      post: [
        {
          label: "colección",
          code: 'omnium.log("llego " + omnium.response.status); omnium.test("ambiente en post", () => omnium.expect(omnium.env.get("marca")).toBe("hoy"));',
        },
      ],
      environment: { keep: "1" },
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.environmentChanged, { marca: "hoy" });
  assert.deepEqual(result.logs, ["colección: llego 200"]);
  const scriptTests = result.assertions.filter((item) => item.id.startsWith("script:"));
  assert.equal(scriptTests.length, 1);
  assert.equal(scriptTests[0]!.passed, true);
  assert.equal(result.assertions.filter((item) => !item.passed).length, 0);
});

test("el pre de la petición corre después de los hooks y completa variables", async () => {
  const request = { ...sampleWorkspace().collections[0]!.requests[0]!, preScript: 'omnium.variables.set("ruta", "health");' };
  const result = await executeRequest({
    request: { ...request, url: "{{baseUrl}}/{{ruta}}" },
    variables: { baseUrl: `http://127.0.0.1:${demo.port}` },
    scripts: { pre: [{ label: "ambiente", code: 'omnium.log("arranca");' }] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.logs, ["ambiente: arranca"]);
  assert.equal(result.extracted.ruta, "health");
});

test("un pre que falla aborta el paso antes de tocar la red", async () => {
  const result = await executeRequest({
    request: { ...sampleWorkspace().collections[0]!.requests[0]!, url: "http://127.0.0.1:1/no" },
    variables: {},
    scripts: { pre: [{ label: "ambiente", code: 'throw new Error("exploto");' }] },
  });
  assert.equal(result.status, null);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ambiente: exploto/);
});

test("los cambios de ambiente se acumulan en toda la corrida", async () => {
  const report = await runCollection({
    requests: sampleWorkspace().collections[0]!.requests.slice(0, 1),
    variables: { baseUrl: `http://127.0.0.1:${demo.port}` },
    scripts: {
      environment: { base: "antes" },
      post: [{ label: "ambiente", code: 'omnium.env.set("base", "despues");' }],
    },
  });
  assert.equal(report.failed, 0);
  assert.deepEqual(report.environmentChanged, { base: "despues" });
});
