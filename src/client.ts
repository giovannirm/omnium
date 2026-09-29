import type { CookieView } from "./core/cookies.ts";
import type {
  CollectionReport,
  ExecutePayload,
  ExecutionResult,
  LoadPayload,
  LoadSnapshot,
  RunPayload,
  Workspace,
} from "./core/types.ts";
import { parseWorkspace } from "./core/files.ts";
import { sampleWorkspace } from "./core/sample.ts";

const STORAGE_KEY = "omnium.workspace.v1";

export type Client = {
  desktop: boolean;
  platform: string;
  load: () => Promise<{ dir: string | null; workspace: Workspace; warning?: string }>;
  save: (workspace: Workspace) => Promise<void>;
  open: () => Promise<{ dir: string; workspace: Workspace } | null>;
  create: () => Promise<{ dir: string; workspace: Workspace } | null>;
  reveal: () => Promise<void>;
  exportFile: (workspace: Workspace) => Promise<boolean>;
  execute: (payload: ExecutePayload) => Promise<ExecutionResult>;
  run: (payload: RunPayload) => Promise<CollectionReport>;
  cancelHttp: () => Promise<void>;
  startLoad: (payload: LoadPayload) => Promise<LoadSnapshot>;
  stopLoad: () => Promise<void>;
  listCookies: () => Promise<CookieView[]>;
  clearCookies: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  onLoadTick: (callback: (snapshot: LoadSnapshot) => void) => () => void;
  onLoadDone: (callback: (snapshot: LoadSnapshot) => void) => () => void;
  onMenu: (callback: (action: "new" | "open") => void) => () => void;
};

const tickListeners = new Set<(snapshot: LoadSnapshot) => void>();
const doneListeners = new Set<(snapshot: LoadSnapshot) => void>();
let httpAbort: AbortController | null = null;

function trackHttp(): AbortSignal {
  const controller = new AbortController();
  httpAbort = controller;
  return controller.signal;
}

const webClient: Client = {
  desktop: false,
  platform: "web",
  async load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { dir: null, workspace: sampleWorkspace() };
    try {
      return { dir: null, workspace: parseWorkspace(JSON.parse(raw) as unknown) };
    } catch {
      try {
        localStorage.setItem(`${STORAGE_KEY}.bak`, raw);
      } catch {
        /* sin espacio para la copia */
      }
      const workspace = sampleWorkspace();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      } catch {
        /* el ejemplo queda solo en memoria */
      }
      return {
        dir: null,
        workspace,
        warning: "El área guardada no se pudo leer. Se abrió un ejemplo y quedó una copia de respaldo en el navegador.",
      };
    }
  },
  async save(workspace) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    } catch {
      throw new Error("No hay espacio para guardar el área en este navegador");
    }
  },
  async open() {
    return null;
  },
  async create() {
    return null;
  },
  async reveal() {},
  async exportFile(workspace) {
    const blob = new Blob([`${JSON.stringify(workspace, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${workspace.name || "omnium"}.omnium.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    return true;
  },
  async execute(payload) {
    const signal = trackHttp();
    try {
      return await post<ExecutionResult>("/__omnium/execute", payload, signal);
    } finally {
      if (httpAbort?.signal === signal) httpAbort = null;
    }
  },
  async run(payload) {
    const signal = trackHttp();
    try {
      return await post<CollectionReport>("/__omnium/run", payload, signal);
    } finally {
      if (httpAbort?.signal === signal) httpAbort = null;
    }
  },
  async cancelHttp() {
    httpAbort?.abort();
  },
  async startLoad(payload) {
    const response = await fetch("/__omnium/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) throw new Error("No se pudo iniciar la carga");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalSnap: LoadSnapshot | null = null;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { type: string; snap?: LoadSnapshot; error?: string };
        if (message.type === "error") throw new Error(message.error || "La carga falló");
        if (!message.snap) continue;
        if (message.type === "tick") tickListeners.forEach((listener) => listener(message.snap as LoadSnapshot));
        if (message.type === "done") {
          finalSnap = message.snap;
          doneListeners.forEach((listener) => listener(message.snap as LoadSnapshot));
        }
      }
    }
    if (!finalSnap) throw new Error("La carga terminó sin resultados");
    return finalSnap;
  },
  async stopLoad() {
    await fetch("/__omnium/load/stop", { method: "POST" });
  },
  async listCookies() {
    const response = await fetch("/__omnium/cookies");
    const payload = (await response.json()) as { cookies?: CookieView[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "No se pudieron leer las cookies");
    return payload.cookies ?? [];
  },
  async clearCookies() {
    await fetch("/__omnium/cookies/clear", { method: "POST" });
  },
  async setTitle(title) {
    document.title = title;
  },
  onLoadTick(callback) {
    tickListeners.add(callback);
    return () => tickListeners.delete(callback);
  },
  onLoadDone(callback) {
    doneListeners.add(callback);
    return () => doneListeners.delete(callback);
  },
  onMenu() {
    return () => undefined;
  },
};

export function getClient(): Client {
  if (typeof window !== "undefined" && window.omnium) return window.omnium;
  return webClient;
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Petición cancelada");
    throw error instanceof Error ? error : new Error("No se pudo completar la operación");
  }
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "No se pudo completar la operación");
  return payload;
}
