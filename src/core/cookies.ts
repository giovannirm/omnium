export type CookieView = {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
  expiresAt: number | null;
};

type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
};

const MAX_COOKIES = 200;

export class CookieJar {
  private cookies: StoredCookie[] = [];

  absorb(requestUrl: URL, setCookies: string[], now = Date.now()): void {
    for (const line of setCookies) {
      const parsed = parseSetCookie(line, now);
      if (!parsed) continue;
      const scope = scopeFor(requestUrl, parsed);
      if (!scope) continue;
      if (parsed.drop || (parsed.expiresAt !== null && parsed.expiresAt <= now)) {
        this.remove(parsed.name, scope.domain, scope.path, scope.hostOnly);
        continue;
      }
      this.upsert({
        name: parsed.name,
        value: parsed.value,
        domain: scope.domain,
        hostOnly: scope.hostOnly,
        path: scope.path,
        secure: parsed.secure,
        expiresAt: parsed.expiresAt,
      });
    }
    this.purge(now);
    if (this.cookies.length > MAX_COOKIES) this.cookies.splice(0, this.cookies.length - MAX_COOKIES);
  }

  headerFor(url: URL, now = Date.now()): string | null {
    this.purge(now);
    const host = url.hostname.toLowerCase();
    const matched = this.cookies.filter((cookie) => matches(cookie, url, host));
    if (!matched.length) return null;
    matched.sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
    return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  list(now = Date.now()): CookieView[] {
    this.purge(now);
    return this.cookies
      .map((cookie) => ({
        host: cookie.domain,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        hostOnly: cookie.hostOnly,
        expiresAt: cookie.expiresAt,
      }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    copy.cookies = this.cookies.map((cookie) => ({ ...cookie }));
    return copy;
  }

  clear(): void {
    this.cookies = [];
  }

  private upsert(cookie: StoredCookie): void {
    const index = this.cookies.findIndex(
      (item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path && item.hostOnly === cookie.hostOnly,
    );
    if (index >= 0) this.cookies[index] = cookie;
    else this.cookies.push(cookie);
  }

  private remove(name: string, domain: string, path: string, hostOnly: boolean): void {
    this.cookies = this.cookies.filter(
      (item) => !(item.name === name && item.domain === domain && item.path === path && item.hostOnly === hostOnly),
    );
  }

  private purge(now: number): void {
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now);
  }
}

type ParsedCookie = {
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  secure: boolean;
  expiresAt: number | null;
  drop: boolean;
};

function parseSetCookie(line: string, now: number): ParsedCookie | null {
  const parts = line.split(";").map((part) => part.trim()).filter(Boolean);
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || name.length > 256 || value.length > 4096 || /[\s;]/.test(name)) return null;

  let domain: string | null = null;
  let path: string | null = null;
  let secure = false;
  let maxAge: number | null = null;
  let expiresAt: number | null = null;
  let sawExpires = false;

  for (const part of parts.slice(1)) {
    const split = part.indexOf("=");
    const key = (split === -1 ? part : part.slice(0, split)).trim().toLowerCase();
    const raw = split === -1 ? "" : part.slice(split + 1).trim();
    if (key === "domain") domain = raw.replace(/^\./, "").toLowerCase();
    else if (key === "path") path = raw.startsWith("/") ? raw : null;
    else if (key === "secure") secure = true;
    else if (key === "max-age") maxAge = Number(raw);
    else if (key === "expires") {
      sawExpires = true;
      const time = Date.parse(raw);
      expiresAt = Number.isFinite(time) ? time : null;
    }
  }

  let drop = false;
  if (maxAge !== null && Number.isFinite(maxAge)) {
    if (maxAge <= 0) drop = true;
    else expiresAt = now + maxAge * 1000;
  } else if (sawExpires) {
    if (expiresAt === null || expiresAt <= now) drop = true;
  } else {
    expiresAt = null;
  }

  return { name, value, domain, path, secure, expiresAt: drop ? null : expiresAt, drop };
}

function scopeFor(requestUrl: URL, parsed: ParsedCookie): { domain: string; hostOnly: boolean; path: string } | null {
  const host = requestUrl.hostname.toLowerCase();
  const path = parsed.path && parsed.path.startsWith("/") ? parsed.path : defaultPath(requestUrl.pathname || "/");
  if (isIp(host) || !parsed.domain) return { domain: host, hostOnly: true, path };
  const domain = parsed.domain;
  if (!acceptableDomain(domain) || !domainMatches(host, domain)) return null;
  return { domain, hostOnly: false, path };
}

function matches(cookie: StoredCookie, url: URL, host: string): boolean {
  if (cookie.secure && url.protocol !== "https:") return false;
  if (cookie.hostOnly) {
    if (cookie.domain !== host) return false;
  } else if (!domainMatches(host, cookie.domain)) return false;
  return pathMatches(url.pathname || "/", cookie.path);
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function acceptableDomain(domain: string): boolean {
  if (!domain || domain.includes("..")) return false;
  if (domain === "localhost") return true;
  return domain.includes(".");
}

function isIp(host: string): boolean {
  return host.startsWith("[") || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const slash = pathname.lastIndexOf("/");
  if (slash <= 0) return "/";
  return pathname.slice(0, slash);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath.charAt(cookiePath.length) === "/";
}
