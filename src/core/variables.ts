import type { Environment, Pair, RequestModel } from "./types.ts";

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function interpolate(input: string, variables: Record<string, string>): string {
  let current = input;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(TOKEN, (match, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
      return variables[name] ?? "";
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

export function placeholders(input: string): string[] {
  const found: string[] = [];
  for (const match of input.matchAll(TOKEN)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export function collectPlaceholders(request: RequestModel): string[] {
  const chunks = [request.url];
  const sendsBody = request.method !== "GET" && request.method !== "HEAD";
  if (sendsBody && (request.bodyMode === "json" || request.bodyMode === "text")) chunks.push(request.bodyRaw);
  for (const row of request.params) if (row.enabled) chunks.push(row.key, row.value);
  for (const row of request.headers) if (row.enabled) chunks.push(row.key, row.value);
  if (sendsBody && request.bodyMode === "form") {
    for (const row of request.form) if (row.enabled) chunks.push(row.key, row.value);
  }
  const auth = request.auth;
  if (auth.type === "bearer") chunks.push(auth.token);
  if (auth.type === "basic") chunks.push(auth.username, auth.password);
  if (auth.type === "apikey") chunks.push(auth.key, auth.value);
  const found: string[] = [];
  for (const chunk of chunks) {
    for (const name of placeholders(chunk)) {
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}

export function resolveVariables(
  environment: Environment | null,
  runtime: Record<string, string>,
  layers?: { globals?: Pair[]; collection?: Pair[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  writePairs(out, layers?.globals ?? []);
  if (environment) writePairs(out, environment.variables);
  writePairs(out, layers?.collection ?? []);
  for (const [key, value] of Object.entries(runtime)) out[key] = value;
  return out;
}

function writePairs(out: Record<string, string>, pairs: Pair[]) {
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!pair.enabled || !key) continue;
    out[key] = pair.value;
  }
}
