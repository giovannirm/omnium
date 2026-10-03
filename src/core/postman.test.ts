import assert from "node:assert/strict";
import { test } from "node:test";
import { exportPostman, importPostman } from "./postman.ts";

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

test("importa events de raíz, carpeta y petición en los scripts", () => {
  const { collection } = importPostman({
    info: { name: "Con scripts", schema: SCHEMA },
    event: [{ listen: "prerequest", script: { exec: ["omnium.log('raiz pre');"] } }],
    item: [
      {
        name: "Carpeta",
        event: [{ listen: "test", script: { exec: ["pm.test('carpeta', () => {});"] } }],
        item: [
          {
            name: "Ping",
            event: [{ listen: "prerequest", script: "pm.variables.set('x', 1);" }],
            request: { method: "GET", url: "https://api.test/ping" },
          },
        ],
      },
    ],
  });
  const request = collection.requests[0];
  assert.ok(request);
  // La carpeta y la petición aportan sus propios scripts…
  assert.match(request.preScript ?? "", /variables\.set\('x', 1\)/);
  assert.match(request.postScript ?? "", /carpeta/);
  // …la raíz vive solo en la colección: el motor ya la corre por petición.
  assert.match(collection.preScript ?? "", /raiz pre/);
  assert.doesNotMatch(request.preScript ?? "", /raiz pre/);
  assert.equal(collection.postScript, undefined);
});

test("la query del raw queda en params y el array query manda en disabled", () => {
  const { collection } = importPostman({
    info: { name: "Q", schema: SCHEMA },
    item: [
      {
        name: "Busca",
        request: {
          method: "GET",
          url: {
            raw: "https://api.test/busca?q=uno&lang=es",
            query: [
              { key: "q", value: "uno" },
              { key: "lang", value: "es", disabled: true },
              { key: "oculto", value: "si", disabled: true },
            ],
          },
        },
      },
      {
        name: "Simple",
        request: { method: "GET", url: "https://api.test/items?page=2#detalle" },
      },
    ],
  });
  const busca = collection.requests[0];
  assert.equal(busca.url, "https://api.test/busca");
  assert.deepEqual(
    busca.params.map((item) => [item.key, item.enabled]),
    [
      ["q", true],
      ["lang", false],
      ["oculto", false],
    ],
  );
  const simple = collection.requests[1];
  assert.equal(simple.url, "https://api.test/items#detalle");
  assert.deepEqual(
    simple.params.map((item) => item.key),
    ["page"],
  );
});

test("hereda auth de raíz/carpeta, respeta la propia y avisa si no se soporta", () => {
  const { collection, warnings } = importPostman({
    info: { name: "Auth", schema: SCHEMA },
    auth: { type: "oauth2", oauth2: [{ key: "accessToken", value: "tok" }] },
    item: [
      {
        name: "Grupo",
        auth: {
          type: "basic",
          basic: [
            { key: "username", value: "ada" },
            { key: "password", value: "x" },
          ],
        },
        item: [
          { name: "Hereda", request: { method: "GET", url: "https://api.test/a" } },
          { name: "Propia", request: { method: "GET", url: "https://api.test/b", auth: { type: "bearer", bearer: [{ key: "token", value: "abc" }] } } },
          { name: "Nula", request: { method: "GET", url: "https://api.test/c", auth: { type: "noauth" } } },
        ],
      },
      { name: "Suelta", request: { method: "GET", url: "https://api.test/d" } },
    ],
  });
  const [hereda, propia, nula, suelta] = collection.requests;
  assert.deepEqual(hereda.auth, { type: "basic", username: "ada", password: "x" });
  assert.deepEqual(propia.auth, { type: "bearer", token: "abc" });
  assert.deepEqual(nula.auth, { type: "none" });
  assert.deepEqual(suelta.auth, { type: "none" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /oauth2/);
  assert.match(warnings[0], /Suelta/);
});

test("roundtrip import → export → import conserva scripts, params y auth", () => {
  const fixture = {
    info: { name: "Ida y vuelta", schema: SCHEMA },
    event: [{ listen: "test", script: { exec: ["pm.test('raiz', () => {});"] } }],
    item: [
      {
        name: "Creador",
        event: [{ listen: "prerequest", script: { exec: ["pm.variables.set('pre', '1');"] } }],
        request: {
          method: "POST",
          url: { raw: "https://api.test/things?debug=1", query: [{ key: "debug", value: "1", disabled: true }] },
          auth: { type: "apikey", apikey: [{ key: "key", value: "X-Key" }, { key: "value", value: "abc" }, { key: "in", value: "header" }] },
          body: { mode: "raw", raw: "{\"n\":1}", options: { raw: { language: "json" } } },
        },
      },
    ],
  };
  const first = importPostman(fixture).collection;
  const second = importPostman(exportPostman(first)).collection;

  assert.equal(second.name, first.name);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].preScript, first.requests[0].preScript);
  assert.equal(second.requests[0].postScript, first.requests[0].postScript);
  assert.equal(second.postScript, first.postScript);
  assert.deepEqual(
    second.requests[0].params.map((item) => [item.key, item.value, item.enabled]),
    first.requests[0].params.map((item) => [item.key, item.value, item.enabled]),
  );
  assert.deepEqual(second.requests[0].auth, first.requests[0].auth);
  assert.equal(second.requests[0].bodyMode, "json");
});
