import assert from "node:assert/strict";
import { test } from "node:test";
import { detectFormat, exportCollectionAs, fileSlug, importCollection } from "./interchange.ts";

const POSTMAN = JSON.stringify({
  info: { name: "Mi colección", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [{ name: "Hola", request: { method: "GET", url: "https://api.test/hola" } }],
});

const AREA = JSON.stringify({
  version: 1,
  name: "Área",
  activeEnvironmentId: null,
  globals: [],
  environments: [],
  collections: [],
  history: [],
});

test("detecta Postman por su esquema", () => {
  assert.equal(detectFormat(POSTMAN, "coleccion.json"), "postman");
});

test("detecta un área de Omnium", () => {
  assert.equal(detectFormat(AREA, "area.json"), "omnium-area");
});

test("detecta Insomnia v4 por __export_format", () => {
  const text = JSON.stringify({ __export_format: 4, resources: [{ _type: "request", name: "Ping" }] });
  assert.equal(detectFormat(text, "export.json"), "insomnia");
});

test("detecta Insomnia v5 por YAML", () => {
  const text = "type: collection.insomnia.rest\nname: Mi colección\n";
  assert.equal(detectFormat(text, "insomnia.yaml"), "insomnia");
});

test("detecta JMeter por jmeterTestPlan y por extensión", () => {
  const xml = '<?xml version="1.0"?><jmeterTestPlan version="1.2"></jmeterTestPlan>';
  assert.equal(detectFormat(xml, "plan.jmx"), "jmeter");
  assert.equal(detectFormat("", "plan.jmx"), "jmeter");
});

test("detecta Bruno por bloques .bru y por extensión", () => {
  const bru = "meta {\n  name: Ping\n}\nhttp {\n  get {\n    url: https://api.test\n  }\n}\n";
  assert.equal(detectFormat(bru, "ping.bru"), "bruno");
  assert.equal(detectFormat(bru), "bruno");
});

test("detecta Hoppscotch por v + items", () => {
  const text = JSON.stringify({ v: 2, name: "API", items: [{ name: "Ping", method: "GET", url: "https://api.test" }] });
  assert.equal(detectFormat(text, "export.json"), "hoppscotch");
});

test("detecta Hoppscotch por su HoppCollection (name + folders + requests)", () => {
  const text = JSON.stringify({ v: 11, name: "API", folders: [], requests: [] });
  assert.equal(detectFormat(text, "export.json"), "hoppscotch");
});

test("detecta Thunder Client por _type request-import", () => {
  const text = JSON.stringify({ _type: "request-import", requests: [{ name: "Ping", method: "get", url: "https://api.test" }] });
  assert.equal(detectFormat(text, "export.json"), "thunder");
});

test("detecta Thunder Client por su Database Format v3", () => {
  const text = JSON.stringify({ version: "1.2", client: "Thunder Client", name: "DB", requests: [], folders: [] });
  assert.equal(detectFormat(text, "export.json"), "thunder");
});

test("un archivo desconocido queda unknown", () => {
  assert.equal(detectFormat("hola mundo", "nota.txt"), "unknown");
  assert.equal(detectFormat(JSON.stringify({ foo: 1 }), "foo.json"), "unknown");
});

test("importCollection trae una colección Postman real", () => {
  const result = importCollection(POSTMAN, "coleccion.json");
  assert.equal(result.collection.name, "Mi colección");
  assert.equal(result.collection.requests.length, 1);
  assert.equal(result.collection.requests[0].method, "GET");
  assert.deepEqual(result.warnings, []);
});

test("importCollection rechaza un área como colección, con error claro", () => {
  assert.throws(() => importCollection(AREA, "area.json"), /área de Omnium/);
});

test("importCollection rechaza formatos desconocidos nombrando el motivo", () => {
  assert.throws(() => importCollection(JSON.stringify({ foo: 1 }), "x.json"), /No se reconoce/);
});

test("importCollection trae colecciones Hoppscotch y Thunder", () => {
  const hopp = importCollection(
    JSON.stringify({ name: "H", folders: [], requests: [{ name: "P", method: "GET", endpoint: "https://api.test" }] }),
    "h.json",
  );
  assert.equal(hopp.collection.name, "H");
  assert.equal(hopp.collection.requests.length, 1);

  const thunder = importCollection(
    JSON.stringify({ client: "Thunder Client", name: "T", folders: [], requests: [{ name: "P", method: "GET", url: "https://api.test" }] }),
    "t.json",
  );
  assert.equal(thunder.collection.name, "T");
  assert.equal(thunder.collection.requests.length, 1);
});

test("importCollection rechaza planes JMeter vacíos nombrando el motivo", () => {
  const jmeter = '<jmeterTestPlan version="1.2"></jmeterTestPlan>';
  assert.throws(() => importCollection(jmeter, "x.jmx"), /no tiene peticiones/);
});

test("importCollection explica un .bru sin petición", () => {
  assert.throws(() => importCollection("meta {\n  name: Vacío\n}\n", "x.bru"), /método HTTP/);
});

test("importCollection explica un Insomnia v4 vacío (sin workspace)", () => {
  const insomnia = JSON.stringify({ __export_format: 4, resources: [] });
  assert.throws(() => importCollection(insomnia, "export.json"), /workspace de colección/);
});

test("detecta Insomnia v5 JSON por el discriminador type", () => {
  const text = JSON.stringify({ type: "collection.insomnia.rest/5.0", name: "Col", collection: [] });
  assert.equal(detectFormat(text, "export.json"), "insomnia");
});

test("importCollection avisa si el JSON está roto", () => {
  assert.throws(() => importCollection("{esto no es json", "x.json"), /No se reconoce|JSON válido/);
});

test("exportCollectionAs genera Postman e Insomnia como JSON con nombre seguro", () => {
  const { collection } = importCollection(POSTMAN, "c.json");

  const postman = exportCollectionAs("postman", collection);
  assert.equal(postman.length, 1);
  assert.match(postman[0].name, /^mi-coleccion\.postman\.json$/);
  const back = JSON.parse(postman[0].content) as { info: { name: string } };
  assert.equal(back.info.name, "Mi colección");

  const insomnia = exportCollectionAs("insomnia", collection);
  assert.equal(insomnia.length, 1);
  assert.match(insomnia[0].name, /^mi-coleccion\.insomnia\.json$/);
  assert.equal((JSON.parse(insomnia[0].content) as { __export_format: number }).__export_format, 4);
});

test("exportCollectionAs en Bruno devuelve proyecto Git-friendly", () => {
  const text = JSON.stringify({
    info: { name: "Dos peticiones", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      { name: "Ping", request: { method: "GET", url: "https://api.test/health" } },
      { name: "Echo", request: { method: "POST", url: { raw: "https://api.test/echo" } } },
    ],
  });
  const { collection } = importCollection(text, "c.json");
  const bru = exportCollectionAs("bruno", collection);
  assert.equal(bru.length, 3);
  assert.equal(bru[0].name, "dos-peticiones/bruno.json");
  assert.match(bru[1].name, /\.bru$/);
  assert.match(bru[1].content, /^meta \{/);
});

test("fileSlug limpia acentos, separadores y queda en minúsculas", () => {
  assert.equal(fileSlug("Café de la Ñ / especial!"), "cafe-de-la-n-especial");
  assert.equal(fileSlug("  "), "coleccion");
});
