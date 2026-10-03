import assert from "node:assert/strict";
import { test } from "node:test";
import { importHoppscotch } from "./hoppscotch.ts";

test("importa HoppCollection: carpetas, refs, auth heredada y scripts", () => {
  const raw = {
    v: 11,
    name: "Demo",
    auth: { authType: "bearer", token: "tok" },
    preRequestScript: "rootPre()",
    testScript: "rootPost()",
    variables: [{ key: "base", value: "https://api.test" }],
    folders: [
      {
        name: "Users",
        folders: [],
        auth: { authType: "inherit" },
        preRequestScript: "folderPre()",
        requests: [
          "15",
          { v: 16, name: "Embebida", method: "GET", endpoint: "https://api.test/e", auth: { authType: "inherit" } },
        ],
      },
    ],
    requests: [
      {
        v: 15,
        name: "Login",
        method: "POST",
        endpoint: "https://api.test/login",
        headers: [
          { key: "X-Api", value: "1", active: true },
          { key: "Off", value: "x", active: false },
        ],
        params: [{ key: "q", value: "1", active: false }],
        body: { contentType: "application/json", body: '{"a":1}' },
        auth: { authType: "inherit" },
        testScript: "testPost()",
      },
      { v: 17, name: "Raíz", method: "GET", endpoint: "https://api.test/root", auth: { authType: "inherit" } },
    ],
  };
  const { collection, warnings } = importHoppscotch(raw);
  assert.equal(collection.name, "Demo");
  assert.equal(collection.preScript, "rootPre()");
  assert.equal(collection.postScript, "rootPost()");
  assert.deepEqual(
    collection.variables.map((v) => [v.key, v.value]),
    [["base", "https://api.test"]],
  );
  assert.deepEqual(warnings, []);
  assert.equal(collection.requests.length, 3);

  const login = collection.requests[0];
  assert.equal(login.name, "Users / Login");
  assert.equal(login.method, "POST");
  assert.deepEqual(login.auth, { type: "bearer", token: "tok" });
  assert.equal(login.bodyMode, "json");
  assert.equal(login.bodyRaw, '{"a":1}');
  assert.equal(login.headers[0]?.enabled, true);
  assert.equal(login.headers[1]?.enabled, false);
  assert.equal(login.params[0]?.enabled, false);
  assert.equal(login.preScript, "folderPre()");
  assert.equal(login.postScript, "testPost()");

  const embebida = collection.requests[1];
  assert.equal(embebida.name, "Users / Embebida");
  assert.deepEqual(embebida.auth, { type: "bearer", token: "tok" });

  const raiz = collection.requests[2];
  assert.equal(raiz.name, "Raíz");
  assert.deepEqual(raiz.auth, { type: "bearer", token: "tok" });
});

test("api-key, multipart, oauth2 y GraphQL avisan sin romper", () => {
  const raw = {
    name: "Avisos",
    folders: [],
    requests: [
      {
        name: "Form",
        method: "POST",
        endpoint: "https://api.test/f",
        body: { contentType: "multipart/form-data", body: [{ key: "file", value: "a.txt", active: true }] },
        auth: { authType: "api-key", key: "X-Key", value: "v", addTo: "query" },
      },
      { name: "OAuth", method: "GET", endpoint: "https://api.test/o", auth: { authType: "oauth2", token: "x" } },
      { name: "GQL", method: "POST", url: "https://api.test/graphql", query: "{ me }", auth: { authType: "none" } },
      {
        name: "GraphBody",
        method: "POST",
        endpoint: "https://api.test/g2",
        body: { contentType: "application/graphql", body: { query: "{ x }" } },
      },
    ],
  };
  const { collection, warnings } = importHoppscotch(raw);
  const text = warnings.join("\n");
  assert.match(text, /oauth2/);
  assert.match(text, /solo se importó la URL/);
  assert.match(text, /Cuerpo GraphQL/);

  const form = collection.requests[0];
  assert.equal(form.bodyMode, "form");
  assert.deepEqual(
    form.form.map((p) => [p.key, p.value]),
    [["file", "a.txt"]],
  );
  assert.deepEqual(form.auth, { type: "apikey", key: "X-Key", value: "v", in: "query" });

  assert.deepEqual(collection.requests[1]?.auth, { type: "none" });
  assert.equal(collection.requests[2]?.url, "https://api.test/graphql");
  assert.equal(collection.requests[3]?.bodyMode, "text");
  assert.equal(collection.requests[3]?.bodyRaw, "{ x }");
});

test("referencia rota avisa; colección vacía importa con nombre por defecto", () => {
  const broken = importHoppscotch({
    name: "Roto",
    folders: [{ name: "F", requests: ["999"], folders: [] }],
    requests: [],
  });
  assert.match(broken.warnings[0] ?? "", /desconocida \(999\)/);
  assert.equal(broken.collection.requests.length, 0);

  const empty = importHoppscotch({ folders: [], requests: [] });
  assert.equal(empty.collection.name, "Hoppscotch");
  assert.deepEqual(empty.warnings, []);
});
