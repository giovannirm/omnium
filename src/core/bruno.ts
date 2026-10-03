import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import { splitQuery } from "./postman.ts";
import type { Assertion, Auth, Pair, RequestModel } from "./types.ts";

type Block = { tag: string; body: string; line: number };
type Entry = { key: string; value: string; enabled: boolean };

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const OP_WORDS = ["notEquals", "notEq", "notContains", "isDefined", "eq", "neq", "contains", "startsWith", "endsWith", "gt", "gte", "lt", "lte"];

/**
 * Importa una petición Bruno (`.bru`): bloques `meta`, método/`http`,
 * `params:*`, `headers`, `auth:*`, `body:*`, `script:*`, `assert`, `docs` y
 * `settings`. `~clave` marca deshabilitado; `tests`/`vars:*` se avisan porque
 * usan la API `bru.*`. El export emite un `.bru` por petición (una descarga
 * por archivo; la estructura de carpetas de Bruno no se recrea).
 */
export function importBru(text: string): ImportResult {
  const blocks = splitBlocks(text);
  if (blocks[0]?.tag === "folder" || blocks[0]?.tag === "collection") {
    throw new Error("El archivo define una carpeta/colección Bruno; importa los archivos .bru de las peticiones");
  }
  const warnings: string[] = [];
  const method = readMethod(blocks, warnings);
  const meta = dictOf(blocks, "meta");
  const name = meta.find((item) => item.key === "name")?.value || "Petición Bruno";

  const query = entriesOf(blocks, "params:query");
  const pathParams = entriesOf(blocks, "params:path");
  const split = splitQuery(method.url);
  const params = query.length > 0 ? query.map((item) => ({ ...pair(item.key, item.value), enabled: item.enabled })) : split.params;

  const bodyBlock = blocks.find((item) => item.tag.startsWith("body:"));
  const body = readBody(bodyBlock, method.bodyType, warnings, name);
  const scripts = readScripts(blocks);
  const scriptCode = `${scripts.pre ?? ""}\n${scripts.post ?? ""}`;
  if (/\bbru\s*\.|\bres\s*\.|\breq\s*\./.test(scriptCode)) {
    warnings.push(`El script de "${name}" usa la API bru.* de Bruno; en Omnium usa pm.* u omnium.*`);
  }
  for (const block of blocks) {
    if (block.tag === "tests" || block.tag.startsWith("vars:")) {
      warnings.push(`El bloque ${block.tag} de "${name}" no se importa (usa la API bru.*); usa el bloque assert`);
    }
  }
  const settings = dictOf(blocks, "settings");
  const redirect = settings.find((item) => item.key === "followRedirects")?.value;

  const docsBlock = blocks.find((item) => item.tag === "docs" || item.tag === "doc");
  const description = docsBlock ? dedent(docsBlock.body).trim() : "";

  const request = createRequest({
    name,
    description,
    method: method.method,
    url: applyPathParams(split.url, pathParams),
    params,
    headers: entriesOf(blocks, "headers").map((item) => ({ ...pair(item.key, item.value), enabled: item.enabled })),
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(blocks, method.authField, warnings, name),
    assertions: readAssertions(blocks, warnings, name),
    ...(redirect !== undefined ? { followRedirects: redirect !== "false" } : {}),
    ...(scripts.pre ? { preScript: scripts.pre } : {}),
    ...(scripts.post ? { postScript: scripts.post } : {}),
  });
  if (request.params.length === 0 && request.headers.length === 0 && !request.url) {
    throw new Error("El archivo no parece una petición Bruno (.bru)");
  }
  return { collection: { id: uid("col"), name, variables: [], requests: [request] }, warnings };
}

export function exportBru(request: RequestModel): string {
  const blocks: string[] = [];
  blocks.push(dictBlock("meta", [
    { key: "name", value: request.name, enabled: true },
    { key: "type", value: "http", enabled: true },
    { key: "seq", value: "1", enabled: true },
  ]));
  const method = request.method.toLowerCase();
  const methodFields: Entry[] = [
    { key: "url", value: request.url, enabled: true },
    { key: "body", value: bruBodyType(request.bodyMode), enabled: true },
    { key: "auth", value: request.auth.type === "none" ? "none" : request.auth.type, enabled: true },
  ];
  if (METHODS.includes(method)) blocks.push(dictBlock(method, methodFields));
  else {
    blocks.push(dictBlock("http", [{ key: "method", value: request.method, enabled: true }, ...methodFields]));
  }
  const query = request.params.filter((item) => item.key.trim());
  if (query.length) {
    blocks.push(dictBlock("params:query", query.map((item) => ({ key: item.key, value: item.value, enabled: item.enabled }))));
  }
  const headers = request.headers.filter((item) => item.key.trim());
  if (headers.length) {
    blocks.push(dictBlock("headers", headers.map((item) => ({ key: item.key, value: item.value, enabled: item.enabled }))));
  }
  const auth = authBlock(request.auth);
  if (auth) blocks.push(auth);
  const body = bodyBlockOf(request);
  if (body) blocks.push(body);
  if (request.preScript?.trim()) blocks.push(textBlock("script:pre-request", request.preScript));
  if (request.postScript?.trim()) blocks.push(textBlock("script:post-response", request.postScript));
  const assertions = assertBlock(request.assertions);
  if (assertions) blocks.push(assertions);
  if (!request.followRedirects) blocks.push(dictBlock("settings", [{ key: "followRedirects", value: "false", enabled: true }]));
  if (request.description.trim()) blocks.push(textBlock("docs", request.description));
  return `${blocks.join("\n\n")}\n`;
}

// ── lectura ───────────────────────────────────────────────────────────────────

/** Bloques `etiqueta { … }`; el cierre es `}` en la columna 0 (formato Bruno). */
function splitBlocks(text: string): Block[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const open = /^([a-z][a-z0-9:_-]*)\s*\{$/.exec(line);
    if (!open) throw new Error(`Bruno: se esperaba un bloque en la línea ${i + 1}`);
    let end = i + 1;
    while (end < lines.length && lines[end] !== "}") end += 1;
    if (end >= lines.length) throw new Error(`Bruno: el bloque ${open[1]} no está cerrado (línea ${i + 1})`);
    blocks.push({ tag: open[1], body: lines.slice(i + 1, end).join("\n"), line: i + 1 });
    i = end + 1;
  }
  return blocks;
}

function readMethod(blocks: Block[], warnings: string[]): { method: RequestModel["method"]; url: string; bodyType: string; authField: string } {
  const http = blocks.find((item) => item.tag === "http");
  const method = blocks.find((item) => METHODS.includes(item.tag));
  const source = method ?? http;
  if (!source) throw new Error("El archivo Bruno no define ningún método HTTP (get, post, …)");
  const fields = dictFrom(source.body);
  const rawMethod = method ? method.tag.toUpperCase() : (fields.find((item) => item.key === "method")?.value ?? "GET").toUpperCase();
  if (!isMethod(rawMethod)) {
    warnings.push(`Método "${rawMethod}" no soportado; se importó como GET`);
    return { method: "GET", ...readMethodFields(fields) };
  }
  return { method: rawMethod, ...readMethodFields(fields) };
}

function readMethodFields(fields: Entry[]): { url: string; bodyType: string; authField: string } {
  return {
    url: fields.find((item) => item.key === "url")?.value ?? "",
    bodyType: (fields.find((item) => item.key === "body")?.value ?? "none").toLowerCase(),
    authField: fields.find((item) => item.key === "auth")?.value ?? "none",
  };
}

function readBody(block: Block | undefined, bodyType: string, warnings: string[], name: string): { mode: RequestModel["bodyMode"]; raw: string; form: Pair[] } {
  const type = (block ? block.tag.slice("body:".length) : bodyType).toLowerCase().replace(/[-_]/g, "");
  if (!block || type === "none") return { mode: "none", raw: "", form: [] };
  if (type === "formurlencoded" || type === "multipartform") {
    return { mode: "form", raw: "", form: dictFrom(block.body).map((item) => ({ ...pair(item.key, item.value), enabled: item.enabled })) };
  }
  const raw = dedent(block.body);
  if (type === "json") return { mode: "json", raw, form: [] };
  if (type === "graphql") {
    warnings.push(`Cuerpo GraphQL de "${name}" se importa como texto`);
    return { mode: "text", raw, form: [] };
  }
  if (type === "xml" || type === "text" || type === "sparql") return { mode: "text", raw, form: [] };
  return { mode: looksJson(raw) ? "json" : "text", raw, form: [] };
}

function readScripts(blocks: Block[]): { pre?: string; post?: string } {
  const pre = blocks.find((item) => item.tag === "script:pre-request");
  const post = blocks.find((item) => item.tag === "script:post-response");
  const preText = pre ? dedent(pre.body).trim() : "";
  const postText = post ? dedent(post.body).trim() : "";
  return { ...(preText ? { pre: preText } : {}), ...(postText ? { post: postText } : {}) };
}

function readAuth(blocks: Block[], field: string, warnings: string[], name: string): Auth {
  const block = blocks.find((item) => item.tag.startsWith("auth:"));
  if (!block) {
    if (field === "inherit") warnings.push(`"${name}" hereda auth de carpeta/colección (no disponible al importar un archivo suelto)`);
    return { type: "none" };
  }
  const type = block.tag.slice("auth:".length);
  const fields = dictFrom(block.body);
  const value = (key: string) => fields.find((item) => item.key === key)?.value ?? "";
  if (type === "bearer") return { type: "bearer", token: value("token") };
  if (type === "basic") return { type: "basic", username: value("username"), password: value("password") };
  if (type === "apikey") {
    const placement = value("placement") === "query" ? "query" : "header";
    return { type: "apikey", key: value("key"), value: value("value"), in: placement };
  }
  warnings.push(`Autenticación "${type}" de "${name}" no soportada; se importa sin autenticación`);
  return { type: "none" };
}

function readAssertions(blocks: Block[], warnings: string[], name: string): Assertion[] {
  const block = blocks.find((item) => item.tag === "assert");
  if (!block) return [];
  const out: Assertion[] = [];
  for (const entry of dictFrom(block.body)) {
    const mapped = mapAssertion(entry);
    if (!mapped) {
      warnings.push(`Aserción "${entry.key}" de "${name}" no soportada; se omitió`);
      continue;
    }
    out.push({ id: uid("assert"), ...mapped });
  }
  return out;
}

/** `$res.status: 200` / `res.status: eq 200` → aserción nativa de Omnium. */
function mapAssertion(entry: Entry): Omit<Assertion, "id"> | null {
  const key = entry.key.replace(/^\$/, "");
  const value = entry.value.trim();
  const parts = value.split(/\s+/);
  const firstIsOp = OP_WORDS.includes(parts[0]);
  // `isDefined` es el único op que va solo; los demás necesitan operando.
  const hasOp = firstIsOp && (parts.length > 1 || parts[0] === "isDefined");
  const word = hasOp ? parts[0] : "eq";
  const expected = hasOp ? parts.slice(1).join(" ") : value;
  const op = normalizeOp(word);
  if (!op) return null;

  let source: Assertion["source"];
  let path = "";
  if (/^res\.status$/.test(key)) source = "status";
  else if (/^res\.time$/.test(key)) source = "time";
  else if (/^res\.headers\.(.+)$/.test(key)) {
    source = "header";
    path = /^res\.headers\.(.+)$/.exec(key)![1];
  } else if (/^res\.body$/.test(key)) source = "body";
  else if (/^res\.body\.(.+)$/.test(key)) {
    source = "json";
    path = /^res\.body\.(.+)$/.exec(key)![1];
  } else return null;

  const allowed: Record<Assertion["source"], Assertion["op"][]> = {
    status: ["eq", "neq", "lt", "lte", "gt", "gte"],
    time: ["lt", "lte", "gt", "gte"],
    header: ["eq", "contains", "exists"],
    json: ["eq", "neq", "contains", "exists", "lt", "gt"],
    body: ["contains"],
  };
  if (source === "body" && op !== "contains") return null;
  if (!allowed[source].includes(op)) return null;
  return { source, op, path, expected: op === "exists" ? "" : expected };
}

function normalizeOp(word: string): Assertion["op"] | null {
  if (word === "eq") return "eq";
  if (word === "notEq" || word === "notEquals" || word === "neq") return "neq";
  if (word === "contains") return "contains";
  if (word === "isDefined") return "exists";
  if (word === "gt" || word === "gte" || word === "lt" || word === "lte") return word;
  return null;
}

/** `:clave` de `params:path` se sustituye en la URL (como en el import de Postman). */
function applyPathParams(url: string, entries: Entry[]): string {
  let out = url;
  for (const entry of entries) {
    if (!entry.enabled || !entry.key) continue;
    out = out.replaceAll(`:${entry.key}`, entry.value);
  }
  return out;
}

// ── bloques y diccionarios ────────────────────────────────────────────────────

function entriesOf(blocks: Block[], tag: string): Entry[] {
  const block = blocks.find((item) => item.tag === tag);
  return block ? dictFrom(block.body) : [];
}

function dictOf(blocks: Block[], tag: string): Entry[] {
  return entriesOf(blocks, tag);
}

/** Líneas `clave: valor` con `~` = deshabilitado; admite claves citadas y `'''` multilínea. */
function dictFrom(body: string): Entry[] {
  const lines = body.split("\n");
  const out: Entry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*\/\//.test(line)) {
      i += 1;
      continue;
    }
    const split = splitColon(line.trim());
    if (!split) {
      i += 1;
      continue;
    }
    const disabled = split.key.startsWith("~");
    const key = unquote(disabled ? split.key.slice(1) : split.key);
    let value = split.value.trim();
    if (value.startsWith("'''")) {
      const collected = [value.slice(3)];
      i += 1;
      while (i < lines.length && !lines[i].includes("'''")) {
        collected.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        const closer = lines[i];
        collected.push(closer.slice(0, closer.indexOf("'''")));
        i += 1;
      }
      value = collected.join("\n");
    } else if (value === "[") {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("]")) i += 1;
      i += 1;
      continue; // listas (tags) se ignoran
    }
    out.push({ key, value: value.trim(), enabled: !disabled });
    i += 1;
  }
  return out;
}

/** Primera `:` fuera de comillas seguida de espacio o fin de línea. */
function splitColon(line: string): { key: string; value: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') quote = ch;
    else if (ch === ":" && (i + 1 >= line.length || line[i + 1] === " ")) {
      return { key: line.slice(0, i).trim(), value: line.slice(i + 1) };
    }
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function dedent(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
}

// ── escritura ─────────────────────────────────────────────────────────────────

function dictBlock(tag: string, entries: Entry[]): string {
  const lines = entries.map((item) => `  ${item.enabled ? "" : "~"}${quoteKey(item.key)}: ${item.value}`);
  return `${tag} {\n${lines.join("\n")}\n}`;
}

function textBlock(tag: string, content: string): string {
  const body = content
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
  return `${tag} {\n${body}\n}`;
}

function quoteKey(key: string): string {
  return /[:{}\[\]]/.test(key) || key.includes(" ") ? `"${key.replaceAll('"', '\\"')}"` : key;
}

function bruBodyType(mode: RequestModel["bodyMode"]): string {
  if (mode === "json") return "json";
  if (mode === "text") return "text";
  if (mode === "form") return "form-url-encoded";
  return "none";
}

function authBlock(auth: Auth): string | null {
  if (auth.type === "bearer") return dictBlock("auth:bearer", [{ key: "token", value: auth.token, enabled: true }]);
  if (auth.type === "basic") {
    return dictBlock("auth:basic", [
      { key: "username", value: auth.username, enabled: true },
      { key: "password", value: auth.password, enabled: true },
    ]);
  }
  if (auth.type === "apikey") {
    return dictBlock("auth:apikey", [
      { key: "key", value: auth.key, enabled: true },
      { key: "value", value: auth.value, enabled: true },
      { key: "placement", value: auth.in, enabled: true },
    ]);
  }
  return null;
}

function bodyBlockOf(request: RequestModel): string | null {
  if (request.bodyMode === "json") return textBlock("body:json", request.bodyRaw);
  if (request.bodyMode === "text") return textBlock("body:text", request.bodyRaw);
  if (request.bodyMode === "form") {
    const entries = request.form
      .filter((item) => item.key.trim())
      .map((item) => ({ key: item.key, value: item.value, enabled: item.enabled }));
    return entries.length ? dictBlock("body:form-urlencoded", entries) : null;
  }
  return null;
}

function assertBlock(assertions: Assertion[]): string | null {
  if (assertions.length === 0) return null;
  const entries: Entry[] = assertions.map((item) => {
    const key =
      item.source === "status"
        ? "$res.status"
        : item.source === "time"
          ? "$res.time"
          : item.source === "header"
            ? `$res.headers.${item.path}`
            : item.source === "json"
              ? `$res.body.${item.path}`
              : "$res.body";
    const opWord = item.op === "eq" ? "eq" : item.op === "neq" ? "notEq" : item.op === "exists" ? "isDefined" : item.op;
    return { key, value: item.op === "exists" ? "isDefined" : `${opWord} ${item.expected}`, enabled: true };
  });
  return dictBlock("assert", entries);
}

function looksJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
