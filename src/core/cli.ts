import { readFile, stat } from "node:fs/promises";
import { EngineRuntime } from "./engine.ts";
import { loadFromDir } from "./disk.ts";
import { importPostman } from "./postman.ts";
import { parseWorkspace } from "./files.ts";
import { externalHooks } from "./script.ts";
import { resolveVariables } from "./variables.ts";
import type { Collection, CollectionReport, Environment, Workspace } from "./types.ts";
import { createModuleLoader } from "../host/moduleLoader.ts";

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type CliOptions = {
  target: string;
  collection: string | null;
  environment: string | null;
  json: boolean;
};

export const USAGE = [
  "Uso:",
  "  omnium run <workspace|colección.json> [opciones]",
  "",
  "Opciones:",
  "  --collection <nombre|id>   ejecuta solo esa colección",
  "  --env <nombre|id>          ambiente a usar (por defecto el activo)",
  "  --json                     informe en JSON para otra herramienta",
  "",
  "Códigos de salida: 0 todo bien, 1 hay fallos, 2 error de uso o de carga.",
].join("\n");

/** Ejecuta el CLI sin tocar `process`: devuelve el código de salida. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command !== "run") {
    io.err(command ? `Comando desconocido: ${command}` : "Falta el comando.");
    io.err("");
    io.err(USAGE);
    return 2;
  }

  let options: CliOptions;
  try {
    options = parseOptions(argv.slice(1));
  } catch (error) {
    io.err(message(error));
    io.err("");
    io.err(USAGE);
    return 2;
  }

  try {
    const { workspace, dir } = await loadTarget(options.target);
    const environment = pickEnvironment(workspace, options.environment);
    const collections = pickCollections(workspace, options.collection);
    const runtime = new EngineRuntime();
    const requireModule = createModuleLoader(dir);
    const reports: { collection: Collection; report: CollectionReport }[] = [];
    for (const collection of collections) {
      const variables = resolveVariables(environment, {}, {
        globals: workspace.globals,
        collection: collection.variables,
      });
      reports.push({
        collection,
        report: await runtime.run({
          requests: collection.requests,
          variables,
          ...externalHooks(collection, environment),
          environment: environment?.variables,
          moduleDir: dir,
          requireModule,
        }),
      });
    }

    const failed = reports.reduce((total, entry) => total + entry.report.failed, 0);
    if (options.json) {
      io.out(JSON.stringify(toJson(workspace, environment, reports), null, 2));
    } else {
      print(io, workspace, environment, reports);
    }
    return failed > 0 ? 1 : 0;
  } catch (error) {
    io.err(message(error));
    return 2;
  }
}

export function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { target: "", collection: null, environment: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--collection" || token === "--env") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} necesita un valor`);
      index += 1;
      if (token === "--collection") options.collection = value;
      else options.environment = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Opción desconocida: ${token}`);
    if (options.target) throw new Error(`Sobra el argumento: ${token}`);
    options.target = token;
  }
  if (!options.target) throw new Error("Falta la ruta del área de trabajo o de la colección");
  return options;
}

async function loadTarget(target: string): Promise<{ workspace: Workspace; dir: string | null }> {
  const info = await stat(target).catch(() => null);
  if (!info) throw new Error(`No existe: ${target}`);
  if (info.isDirectory()) return { workspace: await loadFromDir(target), dir: target };

  const raw = JSON.parse(await readFile(target, "utf8")) as unknown;
  if (raw && typeof raw === "object" && "collections" in raw) return { workspace: parseWorkspace(raw), dir: null };
  const collection = importPostman(raw);
  return {
    dir: null,
    workspace: {
      version: 1,
      name: collection.name,
      activeEnvironmentId: null,
      globals: [],
      environments: [],
      collections: [collection],
      history: [],
    },
  };
}

export function pickEnvironment(workspace: Workspace, asked: string | null): Environment | null {
  if (!asked) {
    return workspace.environments.find((item) => item.id === workspace.activeEnvironmentId) ?? workspace.environments[0] ?? null;
  }
  const wanted = asked.trim().toLowerCase();
  const found = workspace.environments.find(
    (item) => item.id === asked || item.name.toLowerCase() === wanted,
  );
  if (!found) {
    const names = workspace.environments.map((item) => item.name).join(", ");
    throw new Error(`No existe el ambiente "${asked}". Disponibles: ${names || "ninguno"}`);
  }
  return found;
}

export function pickCollections(workspace: Workspace, asked: string | null): Collection[] {
  if (!asked) {
    if (workspace.collections.length === 0) throw new Error("El área no tiene colecciones");
    return workspace.collections;
  }
  const wanted = asked.trim().toLowerCase();
  const found = workspace.collections.filter(
    (item) => item.id === asked || item.name.toLowerCase() === wanted,
  );
  if (found.length === 0) {
    const names = workspace.collections.map((item) => item.name).join(", ");
    throw new Error(`No existe la colección "${asked}". Disponibles: ${names}`);
  }
  return found;
}

function toJson(workspace: Workspace, environment: Environment | null, reports: { collection: Collection; report: CollectionReport }[]) {
  return {
    ok: reports.every((entry) => entry.report.failed === 0),
    area: workspace.name,
    environment: environment?.name ?? null,
    environmentChanged: mergeChanged(reports),
    collections: reports.map(({ collection, report }) => ({
      id: collection.id,
      name: collection.name,
      passed: report.passed,
      failed: report.failed,
      environmentChanged: report.environmentChanged ?? {},
      steps: report.steps.map((step) => ({
        id: step.requestId,
        name: step.name,
        method: step.result.method,
        passed: step.passed,
        status: step.result.status,
        timeMs: step.result.timeMs,
        error: step.result.error,
        logs: step.result.logs ?? [],
        failedAssertions: step.result.assertions.filter((item) => !item.passed).map((item) => item.message),
      })),
    })),
  };
}

function mergeChanged(reports: { report: CollectionReport }[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const { report } of reports) Object.assign(merged, report.environmentChanged ?? {});
  return merged;
}

function print(
  io: CliIo,
  workspace: Workspace,
  environment: Environment | null,
  reports: { collection: Collection; report: CollectionReport }[],
): void {
  const area = environment ? `${workspace.name} · ambiente ${environment.name}` : workspace.name;
  io.out(`Área ${area}`);
  for (const { collection, report } of reports) {
    io.out("");
    io.out(`Colección ${collection.name}`);
    for (const step of report.steps) {
      const mark = step.passed ? "✓" : "✗";
      const where = step.result.error
        ? step.result.error
        : `${step.result.status ?? "—"} · ${step.result.timeMs} ms`;
      io.out(`  ${mark} ${step.result.method} ${step.name} — ${where}`);
      for (const line of step.result.logs ?? []) {
        io.out(`      · ${line}`);
      }
      for (const assertion of step.result.assertions) {
        if (assertion.passed) continue;
        io.out(`      ${assertion.message}`);
      }
    }
  }
  const passed = reports.reduce((total, entry) => total + entry.report.passed, 0);
  const failed = reports.reduce((total, entry) => total + entry.report.failed, 0);
  const changed = mergeChanged(reports);
  if (Object.keys(changed).length) io.out(`Ambiente actualizado: ${Object.keys(changed).join(", ")}`);
  io.out("");
  io.out(`Resultado: ${passed} bien, ${failed} falló`);
}

function message(error: unknown): string {
  if (error instanceof SyntaxError) return `El archivo no es JSON válido (${error.message})`;
  return error instanceof Error ? error.message : String(error);
}
