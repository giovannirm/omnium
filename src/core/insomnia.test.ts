import assert from "node:assert/strict";
import { test } from "node:test";
import { importCollection } from "./interchange.ts";
import { exportInsomnia, importInsomnia } from "./insomnia.ts";

const V4 = JSON.stringify({
  _type: "export",
  __export_format: 4,
  __export_source: "insomnia.desktop.app:v2023.5.8",
  resources: [
    { _id: "wrk_1", _type: "workspace", name: "API Tienda", scope: "collection" },
    { _id: "env_base", _type: "environment", parentId: "wrk_1", name: "Base", data: { base_url: "https://api.tienda.test" } },
    { _id: "env_prod", _type: "environment", parentId: "env_base", name: "Producción", data: { base_url: "https://tienda.test" } },
    { _id: "fld_cat", _type: "request_group", parentId: "wrk_1", name: "Catálogo" },
    {
      _id: "req_1",
      _type: "request",
      parentId: "fld_cat",
      name: "Listar productos",
      method: "GET",
      url: "{{ _.base_url }}/productos?activos=true&pagina=1",
      parameters: [
        { name: "activos", value: "true", disabled: false },
        { name: "pagina", value: "1", disabled: true },
      ],
      headers: [{ name: "Accept", value: "application/json" }],
      description: "Lista paginada",
      authentication: { type: "bearer", token: "{{ _.token }}" },
      scripts: {
        afterResponse: "insomnia.test('ok', () => {\n  insomnia.expect(200).to.eql(200);\n});",
      },
    },
    {
      _id: "req_2",
      _type: "request",
      parentId: "fld_cat",
      name: "Crear producto",
      method: "POST",
      url: "{{ _.base_url }}/productos",
      body: { mimeType: "application/json", text: '{"nombre": "Pan"}' },
      authentication: { type: "basic", username: "admin", password: "secret" },
      settings: { followRedirects: false },
    },
    {
      _id: "req_3",
      _type: "request",
      parentId: "wrk_1",
      name: "Login",
      method: "POST",
      url: "https://auth.tienda.test/login",
      authentication: { type: "oauth2", tokenURL: "https://auth.tienda.test/token" },
    },
  ],
});

const V5 = `
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: Pedidos
meta:
  id: wrk_abc
collection:
  - name: Pedidos API
    meta:
      id: fld_1
    children:
      - name: Crear pedido
        meta:
          id: req_1
        method: POST
        url: https://api.test/pedidos?debug=1
        scripts:
          preRequest: |-
            console.log('pre');
            const a = 1;
          afterResponse: |-
            insomnia.test('status', () => {
              insomnia.expect(200).to.eql(200);
            });
        headers:
          - name: Content-Type
            value: application/json
        parameters:
          - name: debug
            value: "1"
            disabled: false
        body:
          mimeType: application/json
          text: |-
            {
              "sku": "A1"
            }
        authentication:
          type: bearer
          token: "{{ _.token }}"
        settings:
          followRedirects: global
  - name: Salud
    meta:
      id: req_2
    method: GET
    url: https://api.test/salud
environments:
  name: Base Environment
  meta:
    id: env_1
  data:
    token: abc123
  subEnvironments:
    - name: staging
      meta:
        id: env_2
      data:
        token: def456
`;

test("importa Insomnia v4: carpetas, params disabled, auth y avisos", () => {
  const { collection, warnings } = importInsomnia(V4);
  assert.equal(collection.name, "API Tienda");
  assert.deepEqual(
    collection.variables.map((item) => [item.key, item.value]),
    [["base_url", "https://api.tienda.test"]],
  );
  assert.deepEqual(
    collection.requests.map((item) => item.name),
    ["Catálogo / Listar productos", "Catálogo / Crear producto", "Login"],
  );

  const list = collection.requests[0];
  assert.equal(list.url, "{{base_url}}/productos"); // query separada hacia params
  assert.deepEqual(
    list.params.map((item) => [item.key, item.enabled]),
    [["activos", true], ["pagina", false]],
  );
  assert.deepEqual(list.headers[0], { id: list.headers[0].id, key: "Accept", value: "application/json", enabled: true });
  assert.deepEqual(list.auth, { type: "bearer", token: "{{token}}" });
  assert.ok(list.postScript?.includes("insomnia.test('ok'"));

  const create = collection.requests[1];
  assert.equal(create.bodyMode, "json");
  assert.equal(create.bodyRaw, '{"nombre": "Pan"}');
  assert.deepEqual(create.auth, { type: "basic", username: "admin", password: "secret" });
  assert.equal(create.followRedirects, false);

  assert.ok(warnings.some((item) => item.includes("Sub-entornos") && item.includes("Producción")));
  assert.ok(warnings.some((item) => item.includes('oauth2') && item.includes("Login")));
  assert.ok(warnings.some((item) => item.includes("insomnia.*") && item.includes("Listar productos")));
});

test("importa Insomnia v5 YAML: script multilínea, bloque de body y entorno", () => {
  const { collection, warnings } = importInsomnia(V5);
  assert.equal(collection.name, "Pedidos");
  assert.deepEqual(
    collection.variables.map((item) => [item.key, item.value]),
    [["token", "abc123"]],
  );
  assert.ok(warnings.some((item) => item.includes("staging")));

  assert.deepEqual(
    collection.requests.map((item) => item.name),
    ["Pedidos API / Crear pedido", "Salud"],
  );

  const create = collection.requests[0];
  assert.equal(create.url, "https://api.test/pedidos");
  assert.deepEqual(
    create.params.map((item) => [item.key, item.value, item.enabled]),
    [["debug", "1", true]],
  );
  assert.equal(create.preScript, "console.log('pre');\nconst a = 1;");
  assert.ok(create.postScript?.startsWith("insomnia.test('status'"));
  assert.ok(create.postScript?.includes("insomnia.expect(200)"));
  assert.equal(create.bodyMode, "json");
  assert.equal(create.bodyRaw, '{\n  "sku": "A1"\n}');
  assert.deepEqual(create.auth, { type: "bearer", token: "{{token}}" });
  assert.equal(create.followRedirects, true); // "global" no es booleano → default
  assert.ok(warnings.some((item) => item.includes("insomnia.*")));
});

test("roundtrip Insomnia: import → export v4 → import conserva la esencia", () => {
  const first = importInsomnia(V4).collection;
  const exported = exportInsomnia(first);
  const second = importInsomnia(JSON.stringify(exported)).collection;
  assert.equal(second.name, first.name);
  assert.deepEqual(
    second.requests.map((item) => item.name),
    first.requests.map((item) => item.name),
  );
  for (let i = 0; i < first.requests.length; i += 1) {
    const a = first.requests[i];
    const b = second.requests[i];
    assert.equal(b.url, a.url);
    assert.equal(b.method, a.method);
    assert.deepEqual(
      b.params.map((item) => [item.key, item.value, item.enabled]),
      a.params.map((item) => [item.key, item.value, item.enabled]),
    );
    assert.deepEqual(b.auth, a.auth);
    assert.equal(b.bodyMode, a.bodyMode);
    assert.equal(b.bodyRaw, a.bodyRaw);
    assert.equal(b.followRedirects, a.followRedirects);
    assert.equal(b.preScript, a.preScript);
    assert.equal(b.postScript, a.postScript);
  }
  assert.deepEqual(
    second.variables.map((item) => [item.key, item.value]),
    first.variables.map((item) => [item.key, item.value]),
  );
});

test("el dispatcher resuelve Insomnia v5 vía importCollection", () => {
  const { collection, warnings } = importCollection(V5, "insomnia.yaml");
  assert.equal(collection.name, "Pedidos");
  assert.equal(collection.requests.length, 2);
  assert.ok(warnings.length >= 2);
});
