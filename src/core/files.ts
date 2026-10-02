import { createRequest, isMethod, uid } from "./factory.ts";
import type {
  Assertion,
  Auth,
  Collection,
  Environment,
  Extractor,
  HistoryEntry,
  Pair,
  RequestModel,
  Workspace,
} from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function workspaceToFiles(workspace: Workspace): Record<string, string> {
  const files: Record<string, string> = {
    "omnium.json": pretty({
      version: 1,
      name: workspace.name,
      activeEnvironmentId: workspace.activeEnvironmentId,
      globals: workspace.globals,
      environmentOrder: workspace.environments.map((environment) => environment.id),
      collectionOrder: workspace.collections.map((collection) => collection.id),
    }),
    "history.json": pretty(workspace.history),
  };
  for (const environment of workspace.environments) {
    files[`environments/${safe(environment.id)}.json`] = pretty(environment);
  }
  for (const collection of workspace.collections) {
    files[`collections/${safe(collection.id)}/collection.json`] = pretty({
      id: collection.id,
      name: collection.name,
      variables: collection.variables,
      requestOrder: collection.requests.map((request) => request.id),
    });
    for (const request of collection.requests) {
      files[`collections/${safe(collection.id)}/${safe(request.id)}.json`] = pretty(request);
    }
  }
  return files;
}

export function filesToWorkspace(files: Record<string, string>): Workspace {
  const meta = asRecord(parseJson(files["omnium.json"], "omnium.json"));
  if (meta.version !== 1) throw new Error("Esta área pertenece a otra versión de Omnium");
  const environments = ordered(
    stringList(meta.environmentOrder),
    filesByPrefix(files, "environments/"),
    (id, raw) => asEnvironment(parseJson(raw, id)),
  );
  const collections = ordered(stringList(meta.collectionOrder), collectionGroups(files), (id, group) => {
    const info = asRecord(parseJson(group["collection.json"] ?? "", `${id}/collection.json`));
    const requests = ordered(stringList(info.requestOrder), requestFiles(group), (requestId, raw) =>
      asRequest(parseJson(raw, requestId)),
    );
    return { id: ident(info.id, "colección"), name: text(info.name, "Colección"), variables: asPairs(info.variables), requests };
  });
  let history: HistoryEntry[] = [];
  if (files["history.json"]) {
    try {
      history = asHistory(parseJson(files["history.json"], "history.json"));
    } catch {
      history = [];
    }
  }
  const active = typeof meta.activeEnvironmentId === "string" ? meta.activeEnvironmentId : null;
  return {
    version: 1,
    name: text(meta.name, "Omnium"),
    activeEnvironmentId: environments.some((environment) => environment.id === active) ? active : (environments[0]?.id ?? null),
    globals: asPairs(meta.globals),
    environments,
    collections,
    history,
  };
}

export function parseWorkspace(raw: unknown): Workspace {
  const record = asRecord(raw);
  if (record.version !== 1) throw new Error("El archivo no es un área de Omnium");
  const environments = array(record.environments).map((item) => asEnvironment(item));
  const collections = array(record.collections).map((item) => asCollection(item));
  const active = typeof record.activeEnvironmentId === "string" ? record.activeEnvironmentId : null;
  return {
    version: 1,
    name: text(record.name, "Omnium"),
    activeEnvironmentId: environments.some((environment) => environment.id === active) ? active : (environments[0]?.id ?? null),
    globals: asPairs(record.globals),
    environments,
    collections,
    history: asHistory(record.history ?? []),
  };
}

function asCollection(raw: unknown): Collection {
  const record = asRecord(raw);
  return {
    id: ident(record.id, "colección"),
    name: text(record.name, "Colección"),
    variables: asPairs(record.variables),
    requests: array(record.requests).map((item) => asRequest(item)),
  };
}

function asEnvironment(raw: unknown): Environment {
  const record = asRecord(raw);
  return {
    id: ident(record.id, "ambiente"),
    name: text(record.name, "Ambiente"),
    variables: asPairs(record.variables),
  };
}

function asRequest(raw: unknown): RequestModel {
  const record = asRecord(raw);
  const method = text(record.method, "GET").toUpperCase();
  const base = createRequest({
    id: ident(record.id, "petición"),
    name: text(record.name, "Petición"),
    description: text(record.description, ""),
    method: isMethod(method) ? method : "GET",
    url: text(record.url, ""),
    params: asPairs(record.params),
    headers: asPairs(record.headers),
    bodyMode: record.bodyMode === "json" || record.bodyMode === "text" || record.bodyMode === "form" ? record.bodyMode : "none",
    bodyRaw: text(record.bodyRaw, ""),
    form: asPairs(record.form),
    auth: asAuth(record.auth),
    assertions: asAssertions(record.assertions),
    extractors: asExtractors(record.extractors),
    timeoutMs: numberIn(record.timeoutMs, 30000, 50, 120000),
    followRedirects: record.followRedirects !== false,
  });
  return base;
}

function asAuth(raw: unknown): Auth {
  if (!raw || typeof raw !== "object") return { type: "none" };
  const record = raw as Record<string, unknown>;
  if (record.type === "bearer") return { type: "bearer", token: text(record.token, "") };
  if (record.type === "basic") return { type: "basic", username: text(record.username, ""), password: text(record.password, "") };
  if (record.type === "apikey") {
    return {
      type: "apikey",
      key: text(record.key, ""),
      value: text(record.value, ""),
      in: record.in === "query" ? "query" : "header",
    };
  }
  return { type: "none" };
}

function asAssertions(raw: unknown): Assertion[] {
  return array(raw).map((item) => {
    const record = asRecord(item);
    const source = record.source;
    const op = record.op;
    return {
      id: typeof record.id === "string" && ID.test(record.id) ? record.id : uid("assert"),
      source: source === "time" || source === "header" || source === "json" || source === "body" || source === "status" ? source : "status",
      op: isOp(op) ? op : "eq",
      path: text(record.path, ""),
      expected: text(record.expected, ""),
    };
  });
}

function asExtractors(raw: unknown): Extractor[] {
  return array(raw).map((item) => {
    const record = asRecord(item);
    return {
      id: typeof record.id === "string" && ID.test(record.id) ? record.id : uid("extract"),
      name: text(record.name, ""),
      source: record.source === "header" ? "header" : "json",
      path: text(record.path, ""),
    };
  });
}

function asPairs(raw: unknown): Pair[] {
  return array(raw).map((item) => {
    const record = asRecord(item);
    return {
      id: typeof record.id === "string" && ID.test(record.id) ? record.id : uid("pair"),
      key: text(record.key, ""),
      value: text(record.value, ""),
      enabled: record.enabled !== false,
      ...(record.secret === true ? { secret: true } : {}),
    };
  });
}

function asHistory(raw: unknown): HistoryEntry[] {
  return array(raw)
    .slice(0, 40)
    .map((item) => {
      const record = asRecord(item);
      return {
        id: typeof record.id === "string" && ID.test(record.id) ? record.id : uid("hist"),
        at: text(record.at, new Date(0).toISOString()),
        requestId: text(record.requestId, ""),
        name: text(record.name, ""),
        method: text(record.method, "GET"),
        url: text(record.url, ""),
        status: typeof record.status === "number" ? record.status : null,
        timeMs: numberIn(record.timeMs, 0, 0, 600000),
        ok: record.ok === true,
        error: typeof record.error === "string" ? record.error : null,
      };
    });
}

function ordered<T, R>(order: string[], files: Map<string, T>, build: (id: string, value: T) => R): R[] {
  const pending = new Map(files);
  const out: R[] = [];
  for (const id of order) {
    const value = pending.get(id);
    if (value === undefined) continue;
    pending.delete(id);
    out.push(build(id, value));
  }
  for (const [id, value] of pending) out.push(build(id, value));
  return out;
}

function collectionGroups(files: Record<string, string>): Map<string, Record<string, string>> {
  const groups = new Map<string, Record<string, string>>();
  for (const [name, contents] of Object.entries(files)) {
    const match = name.match(/^collections\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const id = match[1] ?? "";
    const file = match[2] ?? "";
    const group = groups.get(id) ?? {};
    group[file] = contents;
    groups.set(id, group);
  }
  return groups;
}

function requestFiles(group: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, contents] of Object.entries(group)) {
    if (name === "collection.json" || !name.endsWith(".json")) continue;
    files.set(name.slice(0, -".json".length), contents);
  }
  return files;
}

function filesByPrefix(files: Record<string, string>, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, contents] of Object.entries(files)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    out.set(name.slice(prefix.length, -".json".length), contents);
  }
  return out;
}

function isOp(value: unknown): value is Assertion["op"] {
  return value === "eq" || value === "neq" || value === "lt" || value === "lte" || value === "gt" || value === "gte" || value === "contains" || value === "exists";
}

function ident(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Identificador de ${label} no válido`);
  return value;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("El archivo de Omnium está incompleto");
  return value as Record<string, unknown>;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`No se pudo leer ${label}`);
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safe(id: string): string {
  if (!ID.test(id)) throw new Error(`Identificador no válido: ${id}`);
  return id;
}
