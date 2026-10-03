import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import type { Assertion, Auth, Collection, Pair, RequestModel } from "./types.ts";

/**
 * Importa colecciones Thunder Client: el formato `_type: "request-import"` y
 * el "Database Format v3" (`client: "Thunder Client"`), además de un array de
 * peticiones sueltas. Carpetas por `containerId` → prefijo `Carpeta / `;
 * `tests` (aserciones sin script) → aserciones nativas; `settings` →
 * `followRedirects`. Timeouts de Thunder se ignoran (unidad incierta).
 */
export function importThunder(raw: unknown): ImportResult {
  const warnings: string[] = [];
  let root: Record<string, unknown>;
  let rows: unknown[];
  if (Array.isArray(raw)) {
    root = {};
    rows = raw;
  } else {
    root = asRecord(raw, "El archivo no es una colección de Thunder Client");
    rows = array(root.requests);
    if (rows.length > 0 && !rows.every((row) => row && typeof row === "object")) {
      throw new Error('El campo "requests" de Thunder Client no se reconoce');
    }
  }
  const folders = new Map<string, { prefix: string; name: string }>();
  if (root.folders) buildFolders(array(root.folders), folders, warnings);
  const requests = rows.map((item) => {
    const record = asRecord(item, "petición");
    return fromRequest(record, prefixFor(record, folders), warnings);
  });
  const collection: Collection = {
    id: uid("col"),
    name: text(root.name, "Thunder Client"),
    variables: [],
    requests,
  };
  return { collection, warnings };
}

/** Prefijo de carpeta anidada (`containerId`) + nombre de la petición. */
function buildFolders(rows: unknown[], out: Map<string, { prefix: string; name: string }>, warnings: string[]): void {
  let remaining = rows.map((row) => asRecord(row, "carpeta"));
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    const unresolved: Record<string, unknown>[] = [];
    for (const folder of remaining) {
      const id = text(folder._id ?? folder.id, "");
      const key = id || `folder-${out.size}`;
      const parent = text(folder.containerId ?? folder.folderId, "");
      const parentEntry = parent ? out.get(parent) : undefined;
      if (parent && !parentEntry) {
        unresolved.push(folder);
        continue;
      }
      if (out.has(key)) continue;
      const base = parentEntry?.prefix ?? "";
      out.set(key, { prefix: `${base}${text(folder.name, "Carpeta")} / `, name: text(folder.name, "Carpeta") });
      progressed = true;
    }
    remaining = unresolved;
  }
  if (remaining.length > 0) {
    warnings.push(`Thunder Client: ${remaining.length} carpeta(s) con jerarquía circular o irresoluble se importaron sin prefijo completo`);
    for (const folder of remaining) {
      const key = text(folder._id ?? folder.id, `folder-${out.size}`);
      if (out.has(key)) continue;
      out.set(key, { prefix: `${text(folder.name, "Carpeta")} / `, name: text(folder.name, "Carpeta") });
    }
  }
}

function prefixFor(record: Record<string, unknown>, folders: Map<string, { prefix: string; name: string }>): string {
  const container = text(record.containerId ?? record.folderId, "");
  return folders.get(container)?.prefix ?? "";
}

function fromRequest(raw: Record<string, unknown>, prefix: string, warnings: string[]): RequestModel {
  const name = `${prefix}${text(raw.name, "Petición")}`;
  const method = text(raw.method, "GET").toUpperCase();
  if (!isMethod(method)) warnings.push(`Método "${method}" de "${name}" no soportado; se importó como GET`);
  const url = text(raw.url, "");
  if (url && !/^https?:\/\//i.test(url) && text(raw.serverId, "")) {
    warnings.push(`"${name}": la URL base del servidor de Thunder Client no está en la exportación; revisa la URL`);
  }
  const body = readBody(raw.body, name, warnings);
  const scripts = readScripts(raw, warnings);
  const settings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? (raw.settings as Record<string, unknown>) : {};
  return createRequest({
    name,
    method: isMethod(method) ? method : "GET",
    url,
    params: readPairs(raw.params),
    headers: readPairs(raw.headers),
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(raw.auth, name, warnings),
    assertions: readAssertions(raw.tests, name, warnings),
    ...(typeof settings.followRedirects === "boolean" ? { followRedirects: settings.followRedirects } : {}),
    ...(scripts.pre ? { preScript: scripts.pre } : {}),
    ...(scripts.post ? { postScript: scripts.post } : {}),
  });
}

/** `headers`/`params`/`form` Thunder: `{name, value, isDisabled}` o `enabled`. */
function readPairs(value: unknown): Pair[] {
  return array(value).map((item) => {
    const record = asRecord(item, "par");
    const enabled = typeof record.enabled === "boolean" ? record.enabled : record.isDisabled !== true;
    return { ...pair(text(record.name ?? record.key, ""), text(record.value, "")), enabled };
  });
}

function readBody(raw: unknown, name: string, warnings: string[]): { mode: RequestModel["bodyMode"]; raw: string; form: Pair[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mode: "none", raw: "", form: [] };
  const body = raw as Record<string, unknown>;
  const type = text(body.type, "none");
  if (type === "formdata" || type === "formencoded") return { mode: "form", raw: "", form: readPairs(body.form) };
  if (type === "graphql") {
    warnings.push(`Cuerpo GraphQL de "${name}" importado como texto; envíalo a mano`);
    const graph = body.graphql && typeof body.graphql === "object" ? (body.graphql as Record<string, unknown>) : {};
    return { mode: "text", raw: text(graph.query, ""), form: [] };
  }
  if (type === "binary") {
    warnings.push(`Cuerpo binario de "${name}" no soportado; se importó sin cuerpo`);
    return { mode: "none", raw: "", form: [] };
  }
  if (type === "json") {
    const rawText = text(body.raw, "");
    return { mode: rawText ? "json" : "none", raw: rawText, form: [] };
  }
  if (type === "text" || type === "xml" || type === "html") {
    const rawText = text(body.raw, "");
    return { mode: rawText ? "text" : "none", raw: rawText, form: [] };
  }
  const rawText = text(body.raw, "");
  return { mode: rawText ? "text" : "none", raw: rawText, form: [] };
}

function readAuth(raw: unknown, name: string, warnings: string[]): Auth {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { type: "none" };
  const record = raw as Record<string, unknown>;
  const type = text(record.type, "none");
  if (type === "none" || !type) return { type: "none" };
  if (type === "bearer") return { type: "bearer", token: text(record.token, "") };
  if (type === "basic") return { type: "basic", username: text(record.username, ""), password: text(record.password, "") };
  if (type === "apikey") {
    return { type: "apikey", key: text(record.key, ""), value: text(record.value, ""), in: text(record.placement, "header") === "query" ? "query" : "header" };
  }
  warnings.push(`Autenticación "${type}" de "${name}" no soportada; se importó sin auth`);
  return { type: "none" };
}

/** `tests` Thunder: `{type, custom, action, value}` → aserciones nativas. */
function readAssertions(raw: unknown, name: string, warnings: string[]): Assertion[] {
  const ops: Record<string, Assertion["op"]> = {
    equals: "eq",
    notequals: "neq",
    contains: "contains",
    lt: "lt",
    lte: "lte",
    gt: "gt",
    gte: "gte",
    notNull: "exists",
  };
  const allowed: Record<string, Assertion["op"][]> = {
    status: ["eq", "neq", "lt", "lte", "gt", "gte"],
    json: ["eq", "neq", "contains", "exists", "lt", "gt"],
    header: ["eq", "contains", "exists"],
    text: ["contains"],
    ms: ["lt", "lte", "gt", "gte"],
  };
  const sourceFor: Record<string, Assertion["source"]> = {
    status: "status",
    json: "json",
    header: "header",
    text: "body",
    ms: "time",
  };
  const out: Assertion[] = [];
  for (const item of array(raw)) {
    const record = asRecord(item, "test");
    const kind = text(record.type, "");
    const action = text(record.action, "");
    const custom = text(record.custom, "");
    const op = ops[action];
    const source = sourceFor[kind];
    if (!op || !source || !allowed[kind]?.includes(op)) {
      if (action) warnings.push(`Aserción Thunder "${name}" (${kind} ${action}) no soportada; se omitió`);
      continue;
    }
    const path = kind === "json" ? custom.replace(/^json\./, "") : kind === "header" ? custom.replace(/^header\./, "") : "";
    out.push({ id: uid("assert"), source, op, path, expected: String(record.value ?? "") });
  }
  return out;
}

function readScripts(raw: Record<string, unknown>, warnings: string[]): { pre?: string; post?: string } {
  const pre = array(raw.preScripts).map((value) => text(value, "")).filter(Boolean).join("\n\n");
  const post = array(raw.postScripts).map((value) => text(value, "")).filter(Boolean).join("\n\n");
  if (pre || post) {
    warnings.push("Scripts de Thunder Client usan la API tc.* y pueden no ejecutarse en Omnium");
  }
  return { ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
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
