import assert from "node:assert/strict";
import { test } from "node:test";
import { filesToWorkspace, workspaceToFiles } from "./files.ts";
import { pair } from "./factory.ts";
import { hasSecrets, maskPairs, maskWorkspace, secretKeys, SECRET_MASK } from "./secrets.ts";
import { sampleWorkspace } from "./sample.ts";
import type { Workspace } from "./types.ts";

function withSecrets(): Workspace {
  const workspace = sampleWorkspace();
  workspace.globals = [pair("region", "eu"), { ...pair("apiKey", "valor-que-no-ve"), secret: true }];
  workspace.environments[0]!.variables = [
    { ...pair("baseUrl", "http://127.0.0.1:4321"), secret: false },
    { ...pair("adminPass", "hunter2"), secret: true },
    { ...pair("offSecret", "visible"), enabled: false, secret: true },
  ];
  workspace.collections[0]!.variables = [{ ...pair("token", "abc123"), secret: true }];
  return workspace;
}

test("maskPairs solo toca las filas marcadas como secretas", () => {
  const rows = [pair("baseUrl", "http://x"), { ...pair("apiKey", "valor-que-no-ve"), secret: true }];
  const masked = maskPairs(rows);
  assert.equal(masked[0]!.value, "http://x");
  assert.equal(masked[1]!.value, SECRET_MASK);
  assert.equal(rows[1]!.value, "valor-que-no-ve", "no debe mutar la original");
});

test("maskWorkspace enmascara globals, ambientes y colecciones sin tocar peticiones", () => {
  const workspace = withSecrets();
  const masked = maskWorkspace(workspace);
  const serialized = JSON.stringify(masked);

  assert.equal(masked.globals[1]!.value, SECRET_MASK);
  assert.equal(masked.environments[0]!.variables[1]!.value, SECRET_MASK);
  assert.equal(masked.collections[0]!.variables[0]!.value, SECRET_MASK);
  assert.equal(masked.environments[0]!.variables[0]!.value, "http://127.0.0.1:4321");

  assert.ok(!serialized.includes("hunter2"), "la exportación filtró un secreto de ambiente");
  assert.ok(!serialized.includes("valor-que-no-ve"), "la exportación filtró un secreto global");
  assert.ok(!serialized.includes("abc123"), "la exportación filtró un secreto de colección");
  assert.ok(serialized.includes("http://127.0.0.1:4321"), "las variables normales deben viajar completas");
  assert.ok(!serialized.includes("visible"), "un secreto deshabilitado también se enmascara");
});

test("el área en disco conserva los valores reales", () => {
  const workspace = withSecrets();
  const files = workspaceToFiles(workspace);
  const reloaded = filesToWorkspace(files);
  const environment = reloaded.environments[0]!;
  assert.equal(environment.variables[1]!.value, "hunter2", "guardar no debe enmascarar");
  assert.equal(environment.variables[1]!.secret, true, "la marca secret debe sobrevivir el ciclo");
  assert.equal(reloaded.collections[0]!.variables[0]!.value, "abc123");
});

test("hasSecrets y secretKeys leen todas las capas", () => {
  const workspace = withSecrets();
  assert.equal(hasSecrets(workspace), true);
  // Las claves deshabilitadas no se usan en runtime: no cuentan como activas.
  assert.deepEqual(secretKeys(workspace).sort(), ["adminPass", "apiKey", "token"]);

  const plain = sampleWorkspace();
  assert.equal(hasSecrets(plain), false);
  assert.deepEqual(secretKeys(plain), []);
});
