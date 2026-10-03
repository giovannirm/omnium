import { readFile, stat } from "node:fs/promises";
import { EngineRuntime } from "../core/engine.ts";
import { loadFromDir } from "./disk.ts";
import { detectFormat, importCollection } from "../core/interchange.ts";
import { parseWorkspace } from "../core/files.ts";
import { externalHooks } from "../core/script.ts";
import { resolveVariables } from "../core/variables.ts";
import type { Collection, Environment, Workspace } from "../core/types.ts";
import { createModuleLoader } from "./moduleLoader.ts";
import { message, print, toJson, type CliIo, type SessionReports } from "./cliFormat.ts";

export type { CliIo } from "./cliFormat.ts";

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
    const { workspace, dir, warnings } = await loadTarget(options.target);
    for (const warning of warnings) io.err(`Aviso: ${warning}`);
    const environment = pickEnvironment(workspace, options.environment);
    const collections = pickCollections(workspace, options.collection);
    const runtime = new EngineRuntime();
    const requireModule = createModuleLoader(dir);
    const reports: SessionReports = [];
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

async function loadTarget(target: string): Promise<{ workspace: Workspace; dir: string | null; warnings: string[] }> {
  const info = await stat(target).catch(() => null);
  if (!info) throw new Error(`No existe: ${target}`);
  if (info.isDirectory()) return { workspace: await loadFromDir(target), dir: target, warnings: [] };

  const text = await readFile(target, "utf8");
  if (detectFormat(text, target) === "omnium-area") {
    return { workspace: parseWorkspace(JSON.parse(text) as unknown), dir: null, warnings: [] };
  }
  const { collection, warnings } = importCollection(text, target);
  return {
    dir: null,
    warnings,
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
