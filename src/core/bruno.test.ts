import assert from "node:assert/strict";
import { test } from "node:test";
import { exportBru, importBru } from "./bruno.ts";

const REQUEST = `meta {
  name: Crear usuario
  type: http
  seq: 1
  tags: [
    usuarios
    smoke
  ]
}

post {
  url: https://api.test/users?notify=true
  body: json
  auth: bearer
}

params:query {
  notify: true
  ~debug: true
}

headers {
  content-type: application/json
  ~x-debug: verbose
}

auth:bearer {
  token: {{authToken}}
}

body:json {
  {
    "nombre": "Ana"
  }
}

assert {
  $res.status: 201
  $res.body.id: isDefined
  $res.headers.content-type: contains application/json
}

script:pre-request {
  bru.setVar("ts", Date.now());
}

script:post-response {
  bru.setEnvVar("lastId", res.getBody().id);
}

docs {
  Crea un usuario nuevo.
}
`;

test("importa una petición Bruno: params ~disabled, bearer, asserts y scripts", () => {
  const { collection, warnings } = importBru(REQUEST);
  assert.equal(collection.requests.length, 1);
  const request = collection.requests[0];
  assert.equal(request.name, "Crear usuario");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.test/users");
  assert.deepEqual(
    request.params.map((item) => [item.key, item.value, item.enabled]),
    [["notify", "true", true], ["debug", "true", false]],
  );
  assert.deepEqual(
    request.headers.map((item) => [item.key, item.enabled]),
    [["content-type", true], ["x-debug", false]],
  );
  assert.deepEqual(request.auth, { type: "bearer", token: "{{authToken}}" });
  assert.equal(request.bodyMode, "json");
  assert.equal(request.bodyRaw, '{\n  "nombre": "Ana"\n}');
  assert.equal(request.preScript, 'bru.setVar("ts", Date.now());');
  assert.equal(request.postScript, "bru.setEnvVar(\"lastId\", res.getBody().id);");
  assert.equal(request.description, "Crea un usuario nuevo.");
  assert.equal(request.assertions.length, 3);
  assert.deepEqual(
    request.assertions.map(({ source, op, path, expected }) => [source, op, path, expected]),
    [
      ["status", "eq", "", "201"],
      ["json", "exists", "id", ""],
      ["header", "contains", "content-type", "application/json"],
    ],
  );
  assert.ok(warnings.some((item) => item.includes("bru.*")));
});

test("roundtrip Bruno: import → export → import conserva la esencia", () => {
  const first = importBru(REQUEST).collection.requests[0];
  const exported = exportBru(first);
  const second = importBru(exported).collection.requests[0];
  assert.equal(second.name, first.name);
  assert.equal(second.method, first.method);
  assert.equal(second.url, first.url);
  assert.deepEqual(
    second.params.map((item) => [item.key, item.value, item.enabled]),
    first.params.map((item) => [item.key, item.value, item.enabled]),
  );
  assert.deepEqual(
    second.headers.map((item) => [item.key, item.value, item.enabled]),
    first.headers.map((item) => [item.key, item.value, item.enabled]),
  );
  assert.deepEqual(second.auth, first.auth);
  assert.equal(second.bodyMode, first.bodyMode);
  assert.equal(second.bodyRaw, first.bodyRaw);
  assert.equal(second.preScript, first.preScript);
  assert.equal(second.postScript, first.postScript);
  assert.equal(second.description, first.description);
  assert.deepEqual(
    second.assertions.map(({ source, op, path, expected }) => [source, op, path, expected]),
    first.assertions.map(({ source, op, path, expected }) => [source, op, path, expected]),
  );
});

test("auth no soportada y bloque tests generan avisos; folder da error claro", () => {
  const oauth = `meta {
  name: OAuth
}

get {
  url: https://api.test
  auth: oauth2
}

auth:oauth2 {
  client_id: abc
}

tests {
  test("ok", () => {});
}
`;
  const { collection, warnings } = importBru(oauth);
  assert.deepEqual(collection.requests[0].auth, { type: "none" });
  assert.ok(warnings.some((item) => item.includes("oauth2")));
  assert.ok(warnings.some((item) => item.includes("tests")));

  assert.throws(
    () => importBru("folder {\n  name: Usuarios\n}\n"),
    /carpeta\/colección Bruno/,
  );
});

test("params:path se sustituye en la URL y método custom pasa por http", () => {
  const bru = `meta {
  name: Cache
}

http {
  method: PURGE
  url: https://api.test/cache/:clave
  body: none
  auth: none
}

params:path {
  clave: productos
}
`;
  const request = importBru(bru).collection.requests[0];
  assert.equal(request.method, "GET"); // PURGE no existe en Omnium → aviso + GET
  assert.equal(request.url, "https://api.test/cache/productos");
});
