import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startDemo } from "../demo/server.ts";
import { runCli, USAGE } from "./cli.ts";
import { saveToDir } from "./disk.ts";
import { sampleWorkspace } from "./sample.ts";
import type { Workspace } from "./types.ts";

let demo: { port: number; close: () => Promise<void> };
let root = "";
let dir = "";

type Io = { out: (line: string) => void; err: (line: string) => void; stdout: string[]; stderr: string[] };

function io(): Io {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (line) => stdout.push(line), err: (line) => stderr.push(line), stdout, stderr };
}

function area(): Workspace {
  const workspace = sampleWorkspace();
  workspace.environments[0]!.variables = [
    { id: "var-base", key: "baseUrl", value: `http://127.0.0.1:${demo.port}`, enabled: true },
  ];
  return workspace;
}

before(async () => {
  demo = await startDemo(0);
  root = await mkdtemp(path.join(tmpdir(), "omnium-cli-"));
  dir = path.join(root, "area");
  await saveToDir(dir, area());
});

after(async () => {
  await demo.close();
  await rm(root, { recursive: true, force: true });
});

test("run ejecuta el área y cierra en 0 cuando todo pasa", async () => {
  const sink = io();
  const code = await runCli(["run", dir], sink);
  assert.equal(sink.stderr.join("\n"), "");
  assert.match(sink.stdout.join("\n"), /Área Omnium · ambiente Local/);
  assert.match(sink.stdout.join("\n"), /Resultado: \d+ bien, 0 falló/);
  assert.equal(code, 0);
});

test("run --json devuelve un informe legible", async () => {
  const sink = io();
  const code = await runCli(["run", dir, "--json"], sink);
  const payload = JSON.parse(sink.stdout.join("\n")) as {
    ok: boolean;
    area: string;
    environment: string;
    collections: { name: string; passed: number; failed: number; steps: { name: string; passed: boolean }[] }[];
  };
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.area, "Omnium");
  assert.equal(payload.environment, "Local");
  assert.equal(payload.collections.length, 1);
  assert.ok(payload.collections[0]!.passed > 0);
  assert.ok(payload.collections[0]!.steps.every((step) => step.passed));
});

test("run --collection y --env filtran por nombre", async () => {
  const sink = io();
  const code = await runCli(["run", dir, "--collection", "demostración", "--env", "Local"], sink);
  assert.equal(code, 0);
  assert.match(sink.stdout.join("\n"), /Colección Demostración/);
});

test("una colección o ambiente inexistente sale con 2 y lista los disponibles", async () => {
  const missingCollection = io();
  assert.equal(await runCli(["run", dir, "--collection", "no-existe"], missingCollection), 2);
  assert.match(missingCollection.stderr.join("\n"), /Disponibles: Demostración/);

  const missingEnvironment = io();
  assert.equal(await runCli(["run", dir, "--env", "qa"], missingEnvironment), 2);
  assert.match(missingEnvironment.stderr.join("\n"), /Disponibles: Local/);
});

test("una ruta inexistente o una opción desconocida sale con 2", async () => {
  const missingPath = io();
  assert.equal(await runCli(["run", path.join(root, "nada")], missingPath), 2);
  assert.match(missingPath.stderr.join("\n"), /No existe/);

  const badFlag = io();
  assert.equal(await runCli(["run", dir, "--rápido"], badFlag), 2);
  assert.match(badFlag.stderr.join("\n"), /Opción desconocida/);
  assert.match(badFlag.stderr.join("\n"), /Códigos de salida/);
});

test("sin comando ni con help se comporta como uso", async () => {
  const none = io();
  assert.equal(await runCli([], none), 2);
  assert.match(none.stderr.join("\n"), /Falta el comando/);

  const help = io();
  assert.equal(await runCli(["help"], help), 0);
  assert.equal(help.stdout.join("\n"), USAGE);

  const unknown = io();
  assert.equal(await runCli(["probar", dir], unknown), 2);
  assert.match(unknown.stderr.join("\n"), /Comando desconocido: probar/);
});

test("una petición que no responde cuenta como fallo y sale con 1", async () => {
  const broken = path.join(root, "roto");
  const workspace = area();
  const collection = workspace.collections[0]!;
  collection.requests = [
    { ...collection.requests[0]!, url: "http://127.0.0.1:1/sin-servidor", assertions: [], extractors: [] },
  ];
  await saveToDir(broken, workspace);
  const sink = io();
  const code = await runCli(["run", broken], sink);
  assert.equal(code, 1);
  assert.match(sink.stdout.join("\n"), /✗ GET/);
  assert.match(sink.stdout.join("\n"), /Resultado: 0 bien, 1 falló/);
});

test("una colección de Postman se ejecuta desde archivo", async () => {
  const file = path.join(root, "postman.json");
  await writeFile(
    file,
    JSON.stringify({
      info: { name: "Importada" },
      item: [{ name: "Salud", request: { method: "GET", url: `http://127.0.0.1:${demo.port}/health`, header: [] } }],
    }),
    "utf8",
  );
  const sink = io();
  const code = await runCli(["run", file], sink);
  assert.equal(code, 0, sink.stderr.join("\n"));
  assert.match(sink.stdout.join("\n"), /Colección Importada/);
});
