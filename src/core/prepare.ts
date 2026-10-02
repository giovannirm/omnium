import { CookieJar } from "./cookies.ts";
import { collectPlaceholders, interpolate } from "./variables.ts";
import type { RequestModel } from "./types.ts";

export type PreparedRequest = {
  url: string;
  method: RequestModel["method"];
  headers: [string, string][];
  body?: string;
  missing: string[];
  error: string | null;
  hostname: string;
};

/** Interpola variables, valida URL, aplica params/headers/auth/body. Nunca tira:
 * los problemas vuelven en `error`/`missing` para que el orquestador los reporte. */
export function prepareRequest(
  request: RequestModel,
  variables: Record<string, string>,
  jar?: CookieJar,
): PreparedRequest {
  const missing = collectPlaceholders(request).filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  const rawUrl = interpolate(request.url, variables).replace(/[\r\n\0]/g, "").trim();
  if (missing.length) {
    return { url: rawUrl, method: request.method, headers: [], missing, error: `Faltan variables: ${missing.join(", ")}`, hostname: "" };
  }
  if (!rawUrl) {
    return { url: "", method: request.method, headers: [], missing, error: "La URL está vacía", hostname: "" };
  }

  let url: URL;
  try {
    url = new URL(normalizeUrl(rawUrl));
  } catch {
    return { url: rawUrl, method: request.method, headers: [], missing, error: "La URL no es válida", hostname: "" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      url: url.toString(),
      method: request.method,
      headers: [],
      missing,
      error: "Solo se permiten direcciones http y https",
      hostname: "",
    };
  }

  for (const param of request.params) {
    if (!param.enabled || !param.key.trim()) continue;
    url.searchParams.append(cleanField(interpolate(param.key, variables)), cleanField(interpolate(param.value, variables)));
  }

  const headers = new Map<string, string>();
  for (const header of request.headers) {
    if (!header.enabled || !header.key.trim()) continue;
    const name = cleanField(header.key);
    if (!name) continue;
    headers.set(name, cleanField(interpolate(header.value, variables)));
  }

  const authError = applyAuth(request, variables, url, headers);
  if (authError) {
    return { url: url.toString(), method: request.method, headers: [...headers], missing, error: authError, hostname: url.hostname };
  }

  if (!hasHeader(headers, "accept")) headers.set("Accept", "*/*");
  if (!hasHeader(headers, "user-agent")) headers.set("User-Agent", "Omnium/0.1");

  const cookie = jar?.headerFor(url);
  if (cookie && !hasHeader(headers, "cookie")) headers.set("Cookie", cookie);

  const canBody = request.method !== "GET" && request.method !== "HEAD";
  let body: string | undefined;
  if (canBody && request.bodyMode === "json") {
    const raw = interpolate(request.bodyRaw, variables);
    if (!raw.trim()) {
      return { url: url.toString(), method: request.method, headers: [...headers], missing, error: "El cuerpo JSON está vacío", hostname: url.hostname };
    }
    try {
      JSON.parse(raw);
    } catch {
      return { url: url.toString(), method: request.method, headers: [...headers], missing, error: "El cuerpo JSON no es válido", hostname: url.hostname };
    }
    body = raw;
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "application/json");
  } else if (canBody && request.bodyMode === "text") {
    body = interpolate(request.bodyRaw, variables);
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "text/plain; charset=utf-8");
  } else if (canBody && request.bodyMode === "form") {
    const params = new URLSearchParams();
    for (const row of request.form) {
      if (!row.enabled || !row.key.trim()) continue;
      params.append(cleanField(interpolate(row.key, variables)), interpolate(row.value, variables));
    }
    body = params.toString();
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  return {
    url: url.toString(),
    method: request.method,
    headers: [...headers.entries()],
    body,
    missing,
    error: null,
    hostname: url.hostname,
  };
}

/** Exporta la petición preparada como comando `curl` copiable. */
export function toCurl(request: RequestModel, variables: Record<string, string>): string {
  const prepared = prepareRequest(request, variables);
  const lines = [`curl -X ${prepared.method} ${shellQuote(prepared.url || request.url)}`];
  for (const [key, value] of prepared.headers) {
    if (key.toLowerCase() === "accept" && value === "*/*") continue;
    if (key.toLowerCase() === "user-agent" && value.startsWith("Omnium/")) continue;
    lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
  }
  if (prepared.body) lines.push(`  --data-raw ${shellQuote(prepared.body)}`);
  const command = lines.join(" \\\n");
  return prepared.error ? `# ${prepared.error}\n${command}` : command;
}

function applyAuth(
  request: RequestModel,
  variables: Record<string, string>,
  url: URL,
  headers: Map<string, string>,
): string | null {
  const auth = request.auth;
  if (auth.type === "none") return null;
  if (auth.type === "bearer") {
    const token = cleanField(interpolate(auth.token, variables));
    if (!token) return "Falta el token de Bearer";
    deleteHeader(headers, "authorization");
    headers.set("Authorization", `Bearer ${token}`);
    return null;
  }
  if (auth.type === "basic") {
    const username = interpolate(auth.username, variables);
    const password = interpolate(auth.password, variables);
    deleteHeader(headers, "authorization");
    headers.set("Authorization", `Basic ${encodeBase64(`${username}:${password}`)}`);
    return null;
  }
  const key = cleanField(interpolate(auth.key, variables));
  const value = cleanField(interpolate(auth.value, variables));
  if (!key) return "Falta el nombre de la clave de API";
  if (auth.in === "query") url.searchParams.append(key, value);
  else {
    deleteHeader(headers, key);
    headers.set(key, value);
  }
  return null;
}

function normalizeUrl(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function hasHeader(headers: Map<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  for (const key of headers.keys()) if (key.toLowerCase() === target) return true;
  return false;
}

function deleteHeader(headers: Map<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of [...headers.keys()]) if (key.toLowerCase() === target) headers.delete(key);
}

function cleanField(value: string): string {
  return value.replace(/[\r\n\0]/g, "").trim();
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
