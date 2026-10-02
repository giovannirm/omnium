import assert from "node:assert/strict";
import { test } from "node:test";
import { runScript, type ScriptRequestState, type ScriptResponseState } from "./script.ts";

const base: { variables: Record<string, string>; environment: Record<string, string> } = {
  variables: { baseUrl: "http://x", token: "" },
  environment: { baseUrl: "http://x" },
};

function request(): ScriptRequestState {
  return { method: "GET", url: "{{baseUrl}}/salud", headers: [{ name: "Accept", value: "application/json" }], body: "" };
}

function response(): ScriptResponseState {
  return {
    status: 200,
    timeMs: 12,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyText: '{"ok":true,"items":[1,2,3]}',
    bodyJson: { ok: true, items: [1, 2, 3] },
  };
}

test("un script vacío no hace nada y devuelve el estado igual", async () => {
  const outcome = await runScript("   ", { phase: "pre", ...base, request: request() });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.logs, []);
  assert.deepEqual(outcome.tests, []);
  assert.equal(outcome.variables.token, "");
});

test("fase pre: lee y escribe variables y toca la petición", async () => {
  const outcome = await runScript(
    `
    omnium.log("arranca", omnium.variables.get("baseUrl"));
    omnium.variables.set("token", "abc");
    omnium.request.headers.push({ name: "X-Token", value: "abc" });
    `,
    { phase: "pre", ...base, request: request() },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.logs, ["arranca http://x"]);
  assert.equal(outcome.variables.token, "abc");
  assert.equal(outcome.request?.headers.length, 2);
  assert.equal(outcome.request?.headers[1]?.value, "abc");
});

test("fase post: las afirmaciones pasan y fallan sin romper el script", async () => {
  const outcome = await runScript(
    `
    omnium.test("estado 200", () => omnium.expect(omnium.response.status).toBe(200));
    omnium.test("trae ítems", () => omnium.expect(omnium.response.bodyJson.items.length).toBe(3));
    omnium.test("esto falla", () => omnium.expect(omnium.response.status).toBe(500));
    omnium.log("fin");
    `,
    { phase: "post", ...base, response: response() },
  );
  assert.equal(outcome.ok, true, "una afirmación fallida no es un error de script");
  assert.equal(outcome.tests.length, 3);
  // El orden debe ser el de llamada, aunque la fallida se resuelva antes.
  assert.match(outcome.tests[0]?.message ?? "", /^estado 200$/);
  assert.equal(outcome.tests[0]?.passed, true);
  assert.match(outcome.tests[2]?.message ?? "", /esto falla — esperaba 500/);
  assert.equal(outcome.tests[2]?.passed, false);
  assert.deepEqual(outcome.logs, ["fin"]);
});

test("omnium.expect cubre los matchers básicos", async () => {
  const outcome = await runScript(
    `
    omnium.test("matchers", () => {
      omnium.expect("hola mundo").toContain("mundo");
      omnium.expect("abc-123").toMatch(/^abc-\\d+$/);
      omnium.expect(3).toBeLessThan(4);
      omnium.expect(5).toBeGreaterThan(4);
      omnium.expect({ a: 1 }).toEqual({ a: 1 });
      omnium.expect("definido").toBeDefined();
      omnium.expect("").toBeFalsy();
    });
    `,
    { phase: "post", ...base, response: response() },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.tests[0]?.passed, true, outcome.tests[0]?.message ?? "");
});

test("un error fuera de omnium.test deja el script en error", async () => {
  const outcome = await runScript(`throw new Error("algo salió mal");`, { phase: "post", ...base });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /algo salió mal/);
});

test("un error de sintaxis se reporta como error", async () => {
  const outcome = await runScript(`const = ;`, { phase: "post", ...base });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
});

test("omnium.test captura errores dentro del chequeo", async () => {
  const outcome = await runScript(
    `
    omnium.test("falla por excepción", () => { throw new Error("adentro"); });
    `,
    { phase: "post", ...base },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.tests[0]?.passed, false);
  assert.match(outcome.tests[0]?.message ?? "", /adentro/);
});

test("env.set cambia solo la copia del ambiente", async () => {
  const outcome = await runScript(`omnium.env.set("nueva", "1"); omnium.variables.set("v", "2");`, {
    phase: "pre",
    ...base,
    request: request(),
  });
  assert.equal(outcome.environment.nueva, "1");
  assert.equal(outcome.variables.v, "2");
  assert.equal(base.environment.nueva, undefined, "no debe mutar la entrada");
  assert.equal(base.variables.v, undefined, "no debe mutar la entrada");
});

test("el deadline corta una espera async larga", async () => {
  const outcome = await runScript(`await omnium.sleep(200);`, { phase: "post", ...base, timeoutMs: 20 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /pasó de 20 ms/);
});

test("omnium.require avisa sin loader y funciona con loader", async () => {
  const sinLoader = await runScript(`omnium.require("fs");`, { phase: "pre", ...base, request: request() });
  assert.equal(sinLoader.ok, false);
  assert.match(sinLoader.error ?? "", /escritorio o la CLI/);

  const conLoader = await runScript(`omnium.log(omnium.require("demo"));`, {
    phase: "pre",
    ...base,
    request: request(),
    require: (specifier) => ({ nombre: specifier }),
  });
  assert.equal(conLoader.ok, true, conLoader.error ?? "");
  assert.deepEqual(conLoader.logs, ['{"nombre":"demo"}']);
});
