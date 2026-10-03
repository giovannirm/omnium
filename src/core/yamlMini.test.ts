import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml } from "./yamlMini.ts";

test("mapas anidados y escalares básicos", () => {
  const doc = parseYaml(`
name: Mi colección
schema_version: "5.1"
enabled: true
count: 3
ratio: 1.5
nothing: null
nested:
  inner: valor
`) as Record<string, unknown>;
  assert.equal(doc.name, "Mi colección");
  assert.equal(doc.schema_version, "5.1");
  assert.equal(doc.enabled, true);
  assert.equal(doc.count, 3);
  assert.equal(doc.ratio, 1.5);
  assert.equal(doc.nothing, null);
  assert.deepEqual(doc.nested, { inner: "valor" });
});

test("secuencias de mapas con ítem en línea", () => {
  const doc = parseYaml(`
collection:
  - name: Listar
    method: GET
    headers:
      - name: Accept
        value: application/json
      - name: X-Off
        value: "1"
        disabled: true
  - name: Crear
    method: POST
`) as { collection: { name: string; method: string; headers: { name: string; disabled?: boolean }[] }[] };
  assert.equal(doc.collection.length, 2);
  assert.equal(doc.collection[0].name, "Listar");
  assert.equal(doc.collection[0].headers.length, 2);
  assert.equal(doc.collection[0].headers[1].disabled, true);
  assert.equal(doc.collection[1].method, "POST");
});

test("secuencia a la misma sangría que su clave", () => {
  const doc = parseYaml(`
items:
- uno
- dos
`) as { items: string[] };
  assert.deepEqual(doc.items, ["uno", "dos"]);
});

test("bloque literal | y |- conserva saltos y comentarios", () => {
  const doc = parseYaml(`
script: |-
  console.log("hola");
  # comentario del script
  const x = 1;
clip: |
  línea
otro: valor
`) as Record<string, string>;
  assert.equal(doc.script, 'console.log("hola");\n# comentario del script\nconst x = 1;');
  assert.equal(doc.clip, "línea\n");
  assert.equal(doc.otro, "valor");
});

test("bloque plegado > une líneas con espacio", () => {
  const doc = parseYaml(`
texto: >
  una línea
  otra línea
sigue: fin
`) as Record<string, string>;
  assert.equal(doc.texto, "una línea otra línea\n");
  assert.equal(doc.sigue, "fin");
});

test("citaciones, escape y comentario en línea", () => {
  const doc = parseYaml(`
doble: "con \\"comillas\\" y\\nsalto"
simple: 'con ''comillas'''
comentada: valor # esto se corta
hash: https://api.test/#/ruta
`) as Record<string, string>;
  assert.equal(doc.doble, 'con "comillas" y\nsalto');
  assert.equal(doc.simple, "con 'comillas'");
  assert.equal(doc.comentada, "valor");
  assert.equal(doc.hash, "https://api.test/#/ruta");
});

test("flow sequence y flow map", () => {
  const doc = parseYaml(`
vacio: []
tags: [a, b, 3]
mapa: { id: 1, nombre: "x" }
`) as { vacio: unknown[]; tags: unknown[]; mapa: Record<string, unknown> };
  assert.deepEqual(doc.vacio, []);
  assert.deepEqual(doc.tags, ["a", "b", 3]);
  assert.deepEqual(doc.mapa, { id: 1, nombre: "x" });
});

test("marcador de documento y comentarios de línea completa", () => {
  const doc = parseYaml(`
---
# comentario
name: ok
`) as Record<string, string>;
  assert.equal(doc.name, "ok");
});

test("error con número de línea ante sangría inválida", () => {
  assert.throws(
    () => parseYaml("a: 1\n    b: 2\n"),
    /YAML inválido en la línea 2/,
  );
});

test("error ante tabulador en la sangría", () => {
  assert.throws(() => parseYaml("a:\n\tb: 2\n"), /espacios, no tabuladores/);
});
