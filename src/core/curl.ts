import { isMethod, pair } from "./factory.ts";
import type { Auth, HttpMethod, Pair, RequestModel } from "./types.ts";

export function parseCurl(input: string): Partial<RequestModel> {
  const tokens = tokenize(input);
  let method: HttpMethod | null = null;
  let url = "";
  const headers: Pair[] = [];
  const data: string[] = [];
  let basic: { username: string; password: string } | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "curl") continue;
    if (isFlag(token, "-X", "--request")) {
      const next = take(tokens, token, index);
      index = next.next - 1;
      const candidate = next.value.toUpperCase();
      if (isMethod(candidate)) method = candidate;
      continue;
    }
    if (isFlag(token, "-H", "--header")) {
      const next = take(tokens, token, index);
      index = next.next - 1;
      const split = next.value.indexOf(":");
      if (split > 0) headers.push(pair(next.value.slice(0, split).trim(), next.value.slice(split + 1).trim()));
      continue;
    }
    if (isFlag(token, "-u", "--user")) {
      const next = take(tokens, token, index);
      index = next.next - 1;
      const split = next.value.indexOf(":");
      basic = {
        username: split >= 0 ? next.value.slice(0, split) : next.value,
        password: split >= 0 ? next.value.slice(split + 1) : "",
      };
      continue;
    }
    if (isFlag(token, "-d", "--data", "--data-raw", "--data-binary")) {
      const next = take(tokens, token, index);
      index = next.next - 1;
      data.push(next.value);
      continue;
    }
    if (isFlag(token, "--url")) {
      const next = take(tokens, token, index);
      index = next.next - 1;
      url = next.value;
      continue;
    }
    if (!token.startsWith("-") && !url) url = token;
  }

  let auth: Auth = basic ? { type: "basic", username: basic.username, password: basic.password } : { type: "none" };
  url = stripUrlAuth(url, (username, password) => {
    if (auth.type === "none") auth = { type: "basic", username, password };
  });

  const bodyRaw = data.join("&");
  let bodyMode: RequestModel["bodyMode"] = "none";
  if (bodyRaw) {
    bodyMode = looksLikeJson(bodyRaw) ? "json" : "text";
    if (!method) method = "POST";
  }

  return {
    method: method ?? "GET",
    url,
    headers,
    params: [],
    bodyMode,
    bodyRaw,
    auth,
  };
}

function stripUrlAuth(value: string, onAuth: (username: string, password: string) => void): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    onAuth(decodeURIComponent(url.username), decodeURIComponent(url.password));
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isFlag(token: string, ...names: string[]): boolean {
  return names.some((name) => token === name || (name.startsWith("--") && token.startsWith(`${name}=`)));
}

function take(tokens: string[], token: string, index: number): { value: string; next: number } {
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0) return { value: token.slice(eq + 1), next: index + 1 };
  return { value: tokens[index + 1] ?? "", next: index + 2 };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += input[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && /\s/.test(input[index + 1] ?? "")) continue;
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}
