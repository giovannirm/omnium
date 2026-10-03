import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import { joinScripts, splitQuery } from "./postman.ts";
import type { Auth, Collection, Pair, RequestModel } from "./types.ts";
import { parseYaml } from "./yamlMini.ts";

type Ctx = { pre?: string; post?: string };

/**
 * Importa colecciones Insomnia: v4 JSON/YAML (`__export_format: 3|4`,
 * `resources` planos) y v5 (`type: collection.insomnia.rest/5.0`, YAML o JSON).
 * Ambiente base → variables de colección; scripts `preRequest`/`afterResponse`
 * → `preScript`/`postScript`; sub-entornos y APIs ajenas viajan como avisos.
 * El export devuelve v4 JSON, que Insomnia sigue importando.
 */
export function importInsomnia(text: string): ImportResult {
  const trimmed = text.trimStart();
  let doc: unknown;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      throw new Error("El archivo no es JSON válido");
    }
  } else {
    doc = parseYaml(text);
  }
  const root = asRecord(doc, "El archivo de Insomnia no se reconoce");
  if (typeof root.__export_format === "number" || Array.isArray(root.resources)) return fromV4(root);
  if (typeof root.type === "string" && root.type.includes("insomnia.rest")) return fromV5(root);
  throw new Error("El archivo no parece una colección de Insomnia (v4 ni v5)");
}

export function exportInsomnia(collection: Collection): unknown {
  const workspaceId = uid("wrk");
  const environmentId = uid("env");
  const resources: Record<string, unknown>[] = [
    { _id: workspaceId, _type: "workspace", name: collection.name, description: "", scope: "collection" },
    {
      _id: environmentId,
      _type: "environment",
      parentId: workspaceId,
      name: "Base Environment",
      data: Object.fromEntries(collection.variables.filter((item) => item.key.trim()).map((item) => [item.key, item.value])),
    },
  ];
  const tree = folderTree(collection.requests);
  // Carpetas primero y luego las de raíz: mantiene el orden del walk de import.
  for (const node of tree.children) writeNode(node, workspaceId, resources);
  for (const request of tree.requests) resources.push(exportRequest(request, workspaceId));
  return {
    _type: "export",
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: "omnium.desktop.app",
    resources,
  };
}

// ── v4 (resources planos) ─────────────────────────────────────────────────────

function fromV4(root: Record<string, unknown>): ImportResult {
  const warnings: string[] = [];
  const resources = array(root.resources).map((item) => asRecord(item, "resource"));
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of resources) if (typeof row._id === "string") byId.set(row._id, row);
  const childrenOf = (id: string) => resources.filter((row) => row.parentId === id);
  const workspaces = resources.filter((row) => row._type === "workspace");
  const workspace = workspaces.find((row) => row.scope !== "design") ?? workspaces[0];
  if (!workspace) throw new Error("El archivo de Insomnia no tiene un workspace de colección");
  const workspaceId = text(workspace._id, "");

  const requests: RequestModel[] = [];
  walkV4(childrenOf(workspaceId), "", requests, {}, warnings, childrenOf);

  const environments = resources.filter((row) => row._type === "environment");
  const base = environments.find((row) => row.parentId === workspaceId) ?? environments[0];
  const subNames = environments.filter((row) => row !== base).map((row) => text(row.name, "(sin nombre)"));
  if (subNames.length) warnings.push(`Sub-entornos no importados: ${subNames.join(", ")}`);
  const variables = base ? dataPairs(base.data) : [];

  if (requests.length === 0) throw new Error("La colección de Insomnia no tiene peticiones");
  return {
    collection: {
      id: uid("col"),
      name: text(workspace.name, "Insomnia"),
      variables,
      requests,
    },
    warnings,
  };
}

function walkV4(
  rows: Record<string, unknown>[],
  prefix: string,
  out: RequestModel[],
  ctx: Ctx,
  warnings: string[],
  childrenOf: (id: string) => Record<string, unknown>[],
): void {
  for (const row of rows) {
    const name = text(row.name, "Petición");
    const type = text(row._type, "");
    if (type === "request_group") {
      const scripts = readScripts(row.scripts);
      walkV4(childrenOf(text(row._id, "")), `${prefix}${name} / `, out, {
        pre: joinScripts(ctx.pre, scripts.pre),
        post: joinScripts(ctx.post, scripts.post),
      }, warnings, childrenOf);
      continue;
    }
    if (type === "request") {
      out.push(requestFrom(row, `${prefix}${name}`, ctx, warnings));
      continue;
    }
    if (type === "grpc_request" || type === "websocket_request") {
      warnings.push(`Se omitió "${name}": solo se importan peticiones HTTP`);
    }
  }
}

// ── v5 (type: collection.insomnia.rest/5.0) ──────────────────────────────────

function fromV5(root: Record<string, unknown>): ImportResult {
  const warnings: string[] = [];
  const requests: RequestModel[] = [];
  walkV5(array(root.collection), "", requests, {}, warnings);
  if (requests.length === 0) throw new Error("La colección de Insomnia no tiene peticiones");

  const environments = asRecordish(root.environments);
  const variables = environments ? dataPairs(environments.data) : [];
  const subs = environments ? array(environments.subEnvironments).map((item) => text(asRecordish(item)?.name, "(sin nombre)")) : [];
  if (subs.length) warnings.push(`Sub-entornos no importados: ${subs.join(", ")}`);

  return {
    collection: { id: uid("col"), name: text(root.name, "Insomnia"), variables, requests },
    warnings,
  };
}

function walkV5(items: unknown[], prefix: string, out: RequestModel[], ctx: Ctx, warnings: string[]): void {
  for (const item of items) {
    const row = asRecordish(item);
    if (!row) continue;
    const name = text(row.name, "Petición");
    if (Array.isArray(row.children)) {
      const scripts = readScripts(row.scripts);
      const folderEnv = asRecordish(row.environment);
      if (folderEnv && Object.keys(folderEnv).length > 0) {
        warnings.push(`Variables de carpeta "${name}" no se importan`);
      }
      walkV5(array(row.children), `${prefix}${name} / `, out, {
        pre: joinScripts(ctx.pre, scripts.pre),
        post: joinScripts(ctx.post, scripts.post),
      }, warnings);
      continue;
    }
    if (row.method === undefined && row.url === undefined) {
      const id = asRecordish(row.meta)?.id;
      if (typeof id === "string" && (id.startsWith("greq_") || id.startsWith("ws-req_"))) {
        warnings.push(`Se omitió "${name}": solo se importan peticiones HTTP`);
      }
      continue;
    }
    out.push(requestFrom(row, `${prefix}${name}`, ctx, warnings));
  }
}

// ── petición (compartido v4/v5) ───────────────────────────────────────────────

function requestFrom(row: Record<string, unknown>, name: string, ctx: Ctx, warnings: string[]): RequestModel {
  const rawUrl = vars(text(row.url, ""));
  const split = splitQuery(rawUrl);
  const rows = pairList(row.parameters).filter((item) => item.key.trim());
  const params = rows.length > 0 ? rows : split.params;
  const body = readBody(row.body);
  const scripts = readScripts(row.scripts);
  const pre = joinScripts(ctx.pre, scripts.pre);
  const post = joinScripts(ctx.post, scripts.post);
  const scriptCode = `${pre ?? ""}\n${post ?? ""}`;
  if (/\binsomnia\s*\./.test(scriptCode)) {
    warnings.push(`El script de "${name}" usa la API insomnia.* de Insomnia; en Omnium usa pm.* u omnium.*`);
  }
  const method = text(row.method, "GET").toUpperCase();
  const normalized = normalizeMethod(method, name, warnings);
  const settings = asRecordish(row.settings);
  const redirect = settings?.followRedirects ?? row.followRedirects;
  return createRequest({
    name,
    description: text(row.description, ""),
    method: normalized,
    url: split.url,
    params,
    headers: pairList(row.headers),
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(row.authentication, warnings, name),
    ...(typeof redirect === "boolean" ? { followRedirects: redirect } : {}),
    ...(pre ? { preScript: pre } : {}),
    ...(post ? { postScript: post } : {}),
  });
}

function normalizeMethod(method: string, name: string, warnings: string[]): RequestModel["method"] {
  if (isMethod(method)) return method;
  const mapped = method === "GQL" || method === "GRAPHQL" ? "POST" : "GET";
  warnings.push(`Método "${method}" de "${name}" no soportado; se importó como ${mapped}`);
  return mapped;
}

function readBody(value: unknown): { mode: RequestModel["bodyMode"]; raw: string; form: Pair[] } {
  const body = asRecordish(value);
  if (!body) return { mode: "none", raw: "", form: [] };
  const mimeType = text(body.mimeType, "").toLowerCase();
  const raw = text(body.text, "");
  if (mimeType.includes("json")) return { mode: "json", raw, form: [] };
  if (mimeType.includes("form-data") || mimeType.includes("x-www-form-urlencoded")) {
    return { mode: "form", raw: "", form: pairList(body.params) };
  }
  if (mimeType.includes("text") || mimeType.includes("graphql")) return { mode: "text", raw, form: [] };
  if (raw.trim()) return { mode: looksJson(raw) ? "json" : "text", raw, form: [] };
  return { mode: "none", raw: "", form: [] };
}

function readAuth(value: unknown, warnings: string[], name: string): Auth {
  const auth = asRecordish(value);
  if (!auth || auth.disabled === true) return { type: "none" };
  const type = text(auth.type, "none").toLowerCase();
  if (type === "none" || type === "") return { type: "none" };
  if (type === "bearer") return { type: "bearer", token: vars(str(auth.token)) };
  if (type === "basic") {
    return { type: "basic", username: vars(str(auth.username)), password: vars(str(auth.password)) };
  }
  if (type === "apikey" || type === "api_key") {
    const location = text(auth.location ?? auth.in, "header") === "query" ? "query" : "header";
    return { type: "apikey", key: str(auth.key), value: vars(str(auth.value)), in: location };
  }
  warnings.push(`Autenticación "${type}" de "${name}" no soportada; se importa sin autenticación`);
  return { type: "none" };
}

function readScripts(value: unknown): { pre?: string; post?: string } {
  const scripts = asRecordish(value);
  if (!scripts) return {};
  const pre = text(scripts.preRequest, "");
  const post = text(scripts.afterResponse, "");
  return { ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
}

/** `{{ _.clave }}` de Insomnia → `{{clave}}` del motor de Omnium. */
function vars(input: string): string {
  return input.replace(/\{\{\s*_\.\s*([^}]+?)\s*\}\}/g, "{{$1}}");
}

function pairList(value: unknown): Pair[] {
  const out: Pair[] = [];
  for (const item of array(value)) {
    const row = asRecordish(item);
    if (!row) continue;
    const key = row.name ?? row.key;
    const enabled = row.disabled !== true;
    out.push({ ...pair(str(key), vars(str(row.value))), enabled });
  }
  return out;
}

function dataPairs(value: unknown): Pair[] {
  const data = asRecordish(value);
  if (!data) return [];
  return Object.entries(data)
    .filter(([key]) => key.trim())
    .map(([key, item]) => pair(key, typeof item === "string" ? item : JSON.stringify(item)));
}

// ── export v4 ─────────────────────────────────────────────────────────────────

type FolderNode = { name: string; children: FolderNode[]; requests: RequestModel[] };

/** Reconstruye la jerarquía desde los prefijos `Carpeta / petición`. */
function folderTree(requests: RequestModel[]): FolderNode {
  const root: FolderNode = { name: "", children: [], requests: [] };
  for (const request of requests) {
    const parts = request.name.split(" / ");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.find((child) => child.name === part);
      if (!next) {
        next = { name: part, children: [], requests: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.requests.push({ ...request, name: parts[parts.length - 1] });
  }
  return root;
}

function writeNode(node: FolderNode, parentId: string, resources: Record<string, unknown>[]): void {
  const folderId = uid("fld");
  resources.push({ _id: folderId, _type: "request_group", parentId, name: node.name, description: "" });
  for (const child of node.children) writeNode(child, folderId, resources);
  for (const request of node.requests) resources.push(exportRequest(request, folderId));
}

function exportRequest(request: RequestModel, parentId: string): Record<string, unknown> {
  const enabled = request.params
    .filter((item) => item.enabled && item.key.trim())
    .map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value)}`)
    .join("&");
  return {
    _id: uid("req"),
    _type: "request",
    parentId,
    name: request.name,
    description: request.description,
    method: request.method,
    url: `${request.url}${enabled ? `?${enabled}` : ""}`,
    parameters: request.params
      .filter((item) => item.key.trim())
      .map((item) => ({ name: item.key, value: item.value, disabled: !item.enabled })),
    headers: request.headers
      .filter((item) => item.key.trim())
      .map((item) => ({ name: item.key, value: item.value, disabled: !item.enabled })),
    body: exportBody(request),
    authentication: exportAuth(request.auth),
    ...(request.preScript || request.postScript
      ? {
          scripts: {
            ...(request.preScript ? { preRequest: request.preScript } : {}),
            ...(request.postScript ? { afterResponse: request.postScript } : {}),
          },
        }
      : {}),
    settings: { followRedirects: request.followRedirects },
  };
}

function exportBody(request: RequestModel): unknown {
  if (request.bodyMode === "none") return {};
  if (request.bodyMode === "form") {
    return {
      mimeType: "application/x-www-form-urlencoded",
      params: request.form
        .filter((item) => item.key.trim())
        .map((item) => ({ name: item.key, value: item.value, disabled: !item.enabled })),
    };
  }
  return {
    mimeType: request.bodyMode === "json" ? "application/json" : "text/plain",
    text: request.bodyRaw,
  };
}

function exportAuth(auth: Auth): unknown {
  if (auth.type === "bearer") return { type: "bearer", token: auth.token };
  if (auth.type === "basic") return { type: "basic", username: auth.username, password: auth.password };
  if (auth.type === "apikey") return { type: "apikey", key: auth.key, value: auth.value, location: auth.in };
  return { type: "none" };
}

// ── utilidades ────────────────────────────────────────────────────────────────

function looksJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} no es válido`);
  return value as Record<string, unknown>;
}

function asRecordish(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
