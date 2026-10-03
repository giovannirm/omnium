import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import { joinScripts } from "./postman.ts";
import type { Auth, Collection, Pair, RequestModel } from "./types.ts";

type Ctx = { auth?: unknown; pre?: string; post?: string };

/**
 * Importa exportaciones de colecciones Hoppscotch (HoppCollection): `name`,
 * `folders` anidadas, `requests` con `endpoint`, body por `contentType`, auth
 * heredada (`authType: "inherit"`) y scripts `preRequestScript`/`testScript`.
 * Acepta peticiones referenciadas por id en `folder.requests` (formato v9)
 * y objetos embebidos. GraphQL (`url` + `query`) se omite con aviso.
 */
export function importHoppscotch(raw: unknown): ImportResult {
  const root = asRecord(raw, "El archivo no es una colección de Hoppscotch");
  const warnings: string[] = [];
  const requests: RequestModel[] = [];
  const pool = new Map<string, Record<string, unknown>>();
  for (const item of array(root.requests)) {
    const request = asRecord(item, "petición");
    const key = String(request.v ?? request.id ?? request._ref_id ?? pool.size);
    pool.set(key, request);
  }
  const claimed = new Set<string>();
  const rootCtx: Ctx = { auth: root.auth, pre: "", post: "" };
  for (const folder of array(root.folders)) {
    walkFolder(folder, "", rootCtx, requests, warnings, pool, claimed);
  }
  for (const [key, request] of pool) {
    if (claimed.has(key)) continue;
    requests.push(fromRequest(request, text(request.name, "Petición"), rootCtx, warnings));
  }
  const collection: Collection = {
    id: uid("col"),
    name: text(root.name, "Hoppscotch"),
    variables: readVariables(root.variables),
    requests,
    ...(text(root.preRequestScript, "") ? { preScript: text(root.preRequestScript, "") } : {}),
    ...(text(root.testScript, "") ? { postScript: text(root.testScript, "") } : {}),
  };
  return { collection, warnings };
}

function walkFolder(
  raw: unknown,
  prefix: string,
  ctx: Ctx,
  out: RequestModel[],
  warnings: string[],
  pool: Map<string, Record<string, unknown>>,
  claimed: Set<string>,
): void {
  const folder = asRecord(raw, "carpeta");
  const name = text(folder.name, "Carpeta");
  const folderCtx: Ctx = {
    auth: resolveAuth(folder.auth, ctx.auth),
    pre: joinScripts(ctx.pre, text(folder.preRequestScript, "")),
    post: joinScripts(ctx.post, text(folder.testScript, "")),
  };
  for (const entry of array(folder.requests)) {
    if (typeof entry === "string" || typeof entry === "number") {
      const id = String(entry);
      const key = pool.has(id) ? id : pool.has(String(Number(id))) ? String(Number(id)) : undefined;
      if (!key) {
        warnings.push(`Hoppscotch: la carpeta "${name}" referencia una petición desconocida (${id})`);
        continue;
      }
      if (claimed.has(key)) continue;
      claimed.add(key);
      const target = pool.get(key);
      if (target) out.push(fromRequest(target, `${prefix}${name} / ${text(target.name, "Petición")}`, folderCtx, warnings));
      continue;
    }
    const request = asRecord(entry, "petición");
    out.push(fromRequest(request, `${prefix}${name} / ${text(request.name, "Petición")}`, folderCtx, warnings));
  }
  for (const child of array(folder.folders)) {
    walkFolder(child, `${prefix}${name} / `, folderCtx, out, warnings, pool, claimed);
  }
}

function fromRequest(raw: Record<string, unknown>, name: string, ctx: Ctx, warnings: string[]): RequestModel {
  const method = text(raw.method, "GET").toUpperCase();
  if (!isMethod(method)) warnings.push(`Método "${method}" de "${name}" no soportado; se importó como GET`);
  const endpoint = text(raw.endpoint, "");
  if (!endpoint && text(raw.url, "")) {
    warnings.push(`Petición GraphQL de Hoppscotch "${name}": solo se importó la URL`);
  }
  const url = endpoint || text(raw.url, "");
  const body = readBody(raw.body, name, warnings);
  const pre = joinScripts(ctx.pre, text(raw.preRequestScript, ""));
  const post = joinScripts(ctx.post, text(raw.testScript, ""));
  return createRequest({
    name,
    description: text(raw.description, ""),
    method: isMethod(method) ? method : "GET",
    url,
    params: readPairs(raw.params),
    headers: readPairs(raw.headers),
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(resolveAuth(raw.auth, ctx.auth), name, warnings),
    ...(pre ? { preScript: pre } : {}),
    ...(post ? { postScript: post } : {}),
  });
}

/** `authType: "inherit"` o ausente → lo heredado de la carpeta/raíz. */
function resolveAuth(own: unknown, parent: unknown): unknown {
  if (!own || typeof own !== "object" || Array.isArray(own)) return parent;
  const record = own as Record<string, unknown>;
  if (text(record.authType, "") === "inherit") return parent;
  return record;
}

/** `headers`/`params` Hoppscotch: `{key, value, active}` (active !== false). */
function readPairs(value: unknown): Pair[] {
  return array(value).map((item) => {
    const record = asRecord(item, "par");
    return {
      ...pair(text(record.key, ""), text(record.value, "")),
      enabled: record.active !== false,
    };
  });
}

function readBody(raw: unknown, name: string, warnings: string[]): { mode: RequestModel["bodyMode"]; raw: string; form: Pair[] } {
  if (raw === null || raw === undefined) return { mode: "none", raw: "", form: [] };
  const body = asRecord(raw, "body");
  const contentType = text(body.contentType, "");
  const content = body.body;
  if (contentType === "multipart/form-data" || contentType === "application/x-www-form-urlencoded") {
    return { mode: "form", raw: "", form: readPairs(content) };
  }
  if (contentType === "application/graphql" || (content && typeof content === "object" && !Array.isArray(content) && "query" in (content as object))) {
    warnings.push(`Cuerpo GraphQL de "${name}" importado como texto; envíalo a mano`);
    const graph = content && typeof content === "object" ? asRecord(content, "graphql") : {};
    return { mode: "text", raw: text(graph.query, ""), form: [] };
  }
  if (Array.isArray(content)) return { mode: "form", raw: "", form: readPairs(content) };
  const rawText = typeof content === "string" ? content : "";
  return { mode: rawText ? (contentType.includes("json") || looksJson(rawText) ? "json" : "text") : "none", raw: rawText, form: [] };
}

function looksJson(value: string): boolean {
  const head = value.trim();
  return head.startsWith("{") || head.startsWith("[");
}

/** Auth Hoppscotch: none/basic/bearer/api-key heredable; resto avisa. */
function readAuth(raw: unknown, name: string, warnings: string[]): Auth {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const authType = record ? text(record.authType, "none") : "none";
  if (authType === "inherit" || !record) return { type: "none" };
  if (authType === "none") return { type: "none" };
  if (authType === "bearer") return { type: "bearer", token: text(record.token, "") };
  if (authType === "basic") return { type: "basic", username: text(record.username, ""), password: text(record.password, "") };
  if (authType === "api-key") {
    return { type: "apikey", key: text(record.key, ""), value: text(record.value, ""), in: text(record.addTo, "header") === "query" ? "query" : "header" };
  }
  warnings.push(`Autenticación "${authType}" de "${name}" no soportada; se importó sin auth`);
  return { type: "none" };
}

function readVariables(value: unknown): Pair[] {
  return array(value).map((item) => {
    const record = asRecord(item, "variable");
    return pair(text(record.key ?? record.name, ""), text(record.value, ""));
  });
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`El campo "${label}" no se reconoce`);
  }
  return value as Record<string, unknown>;
}
