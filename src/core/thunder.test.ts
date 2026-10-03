import assert from "node:assert/strict";
import { test } from "node:test";
import { importThunder } from "./thunder.ts";

test("importa _type request-import con carpetas anidadas, tests y settings", () => {
  const raw = {
    _type: "request-import",
    name: "Tienda",
    folders: [
      { _id: "f1", name: "Users", colId: "c1" },
      { _id: "f2", name: "Admin", colId: "c1", containerId: "f1" },
    ],
    requests: [
      {
        name: "Listar",
        url: "https://api.test/users",
        method: "GET",
        headers: [
          { name: "X-On", value: "1", isDisabled: false },
          { name: "X-Off", value: "2", isDisabled: true },
        ],
        params: [{ name: "page", value: "1" }],
        auth: { type: "none" },
        tests: [
          { type: "status", custom: "", action: "equals", value: 200 },
          { type: "json", custom: "json.data.id", action: "contains", value: "9" },
          { type: "text", custom: "", action: "startsWith", value: "<" },
        ],
        settings: { followRedirects: false },
      },
      { name: "Ver", colId: "c1", containerId: "f2", url: "https://api.test/u/1", method: "GET" },
      { name: "Crear", url: "https://api.test/u", method: "POST", body: { type: "json", raw: '{"n":1}' }, auth: { type: "bearer", token: "abc" } },
      { name: "Raíz", colId: "c1", url: "https://api.test/", method: "PUT" },
    ],
  };
  const { collection, warnings } = importThunder(raw);
  assert.equal(collection.name, "Tienda");
  assert.equal(collection.requests.length, 4);

  const listar = collection.requests[0];
  assert.equal(listar.name, "Listar");
  assert.equal(listar.headers[0]?.enabled, true);
  assert.equal(listar.headers[1]?.enabled, false);
  assert.equal(listar.params[0]?.enabled, true);
  assert.equal(listar.followRedirects, false);
  assert.deepEqual(
    listar.assertions.map((a) => [a.source, a.op, a.path, a.expected]),
    [["status", "eq", "", "200"], ["json", "contains", "data.id", "9"]],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /startsWith/);

  assert.equal(collection.requests[1]?.name, "Users / Admin / Ver");
  assert.equal(collection.requests[2]?.bodyMode, "json");
  assert.deepEqual(collection.requests[2]?.auth, { type: "bearer", token: "abc" });
  assert.equal(collection.requests[3]?.method, "PUT");
  assert.equal(collection.requests[3]?.name, "Raíz");
});

test("Database Format v3 (client) y array de peticiones sueltas", () => {
  const v3 = importThunder({
    version: "1.2",
    client: "Thunder Client",
    name: "DB",
    folders: [],
    requests: [{ name: "Ping", url: "https://api.test/ping", method: "GET" }],
  });
  assert.equal(v3.collection.name, "DB");
  assert.equal(v3.collection.requests.length, 1);
  assert.deepEqual(v3.warnings, []);

  const rows = importThunder([
    { name: "A", method: "get", url: "https://api.test/a", serverId: "s1" },
    { name: "B", method: "GET", url: "/relativa", serverId: "s1" },
  ]);
  assert.equal(rows.collection.name, "Thunder Client");
  assert.equal(rows.collection.requests[0]?.method, "GET");
  assert.match(rows.warnings[0] ?? "", /URL base del servidor/);
});

test("formencoded, graphql, auth desconocida, scripts y método raro avisan", () => {
  const { collection, warnings } = importThunder({
    name: "Casos",
    folders: [{ _id: "huerfa", name: "Perdida", containerId: "no-existe" }],
    requests: [
      {
        name: "Form",
        containerId: "huerfa",
        method: "POST",
        url: "https://api.test/f",
        body: { type: "formencoded", form: [{ name: "a", value: "1" }] },
        auth: { type: "digest", username: "u" },
        preScripts: ["tc.env.get('x')"],
      },
      { name: "GQL", method: "POST", url: "https://api.test/gql", body: { type: "graphql", graphql: { query: "{ q }" } } },
      { name: "Raro", method: "TRACE", url: "https://api.test/t" },
    ],
  });
  const text = warnings.join("\n");
  assert.match(text, /irresoluble/);
  assert.match(text, /"digest"/);
  assert.match(text, /tc\.\*/);
  assert.match(text, /Cuerpo GraphQL/);
  assert.match(text, /TRACE/);

  const form = collection.requests[0];
  assert.equal(collection.requests[0]?.name, "Perdida / Form");
  assert.equal(form.bodyMode, "form");
  assert.deepEqual(
    form.form.map((p) => [p.key, p.value]),
    [["a", "1"]],
  );
  assert.deepEqual(form.auth, { type: "none" });
  assert.match(form.preScript ?? "", /tc\.env\.get/);
  assert.equal(collection.requests[1]?.bodyRaw, "{ q }");
  assert.equal(collection.requests[2]?.method, "GET");
});
