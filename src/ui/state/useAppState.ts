import { useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../../client.ts";
import type { CookieView } from "../../core/cookies.ts";
import { parseWorkspace } from "../../core/files.ts";
import { importPostman } from "../../core/postman.ts";
import { externalHooks } from "../../core/script.ts";
import type {
  ExecutionResult,
  LoadPlan,
  LoadSnapshot,
  Workspace,
} from "../../core/types.ts";
import { resolveVariables } from "../../core/variables.ts";
import { hasSecrets, maskWorkspace } from "../../core/secrets.ts";
import type { Command } from "../palette.tsx";
import {
  activeEnvironment,
  appendCollection,
  appendCollectionRaw,
  appendEnvironment,
  appendRequest,
  applyEnvironmentChanges,
  closeTabAt,
  defaultSelection,
  diffVars,
  duplicateRequest,
  failedResult,
  historyEntry,
  locate,
  moveRequestIn,
  openTab,
  pruneSelection,
  pruneTabs,
  removeCollection,
  removeEnvironment,
  removeRequestIn,
  toTab,
  updateEnvironmentIn,
  updateRequestIn,
  withHistory,
  type Selection,
  type Tab,
} from "./model.ts";

export type Modal = null | "help" | "curl" | "palette" | "snippet" | "cookies";
export type Pane = "response" | "tests" | "load";
export type LoadState = { running: boolean; points: number[]; snap: LoadSnapshot | null };
export type SessionReport = { collectionId: string; report: Awaited<ReturnType<Client["run"]>> };

const DEFAULT_PLAN: LoadPlan = {
  concurrency: 10,
  rampUpMs: 1000,
  durationMs: 8000,
  timeoutMs: 5000,
  pauseMs: 0,
  maxErrorPct: 1,
  maxP95Ms: 500,
};

export type AppState = ReturnType<typeof useAppState>;

/**
 * Capa de estado de la aplicación. Toda la orquestación vive acá: la UI solo
 * compone y renderiza. Se carga por dominios: workspace/persistencia y
 * selección; ejecución y carga; después el chrome de la interfaz.
 */
export function useAppState(options: { client: Client }) {
  const { client } = options;

  // --- workspace y persistencia ---
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [saveLabel, setSaveLabel] = useState("Listo");

  // --- selección y pestañas ---
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);

  // --- ejecución: resultados, informes y variables de corrida ---
  const [results, setResults] = useState<Record<string, ExecutionResult>>({});
  const [report, setReport] = useState<SessionReport | null>(null);
  const [runtime, setRuntime] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [pane, setPane] = useState<Pane>("response");
  const busy = useRef(false);

  // --- carga ---
  const [load, setLoad] = useState<LoadState>({ running: false, points: [], snap: null });
  const [plan, setPlan] = useState<LoadPlan>(DEFAULT_PLAN);

  // --- avisos ---
  const [toast, setToast] = useState<string | null>(null);

  // --- cookies de sesión ---
  const [cookieRows, setCookieRows] = useState<CookieView[]>([]);

  const hydrated = useRef(false);
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = workspace;

  const selected = useMemo(() => locate(workspace, selection), [workspace, selection]);
  const environment = activeEnvironment(workspace);
  const activeCollection = selected && "collection" in selected ? selected.collection : null;
  const variables = resolveVariables(environment, runtime, {
    globals: workspace?.globals ?? [],
    collection: activeCollection?.variables ?? [],
  });

  function notify(message: string, ms = 3200): void {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), ms);
  }

  useEffect(() => {
    let live = true;
    void client.load().then((loaded) => {
      if (!live) return;
      setWorkspace(loaded.workspace);
      setDir(loaded.dir);
      const picked = defaultSelection(loaded.workspace);
      if (picked) {
        setSelection(picked);
        const tab = toTab(picked);
        if (tab) setTabs([tab]);
      }
      if (loaded.warning) notify(loaded.warning, 5200);
      void refreshCookies();
    });
    return () => {
      live = false;
    };
  }, [client]);

  async function refreshCookies(): Promise<void> {
    try {
      setCookieRows(await client.listCookies());
    } catch {
      return;
    }
  }

  async function forgetCookies(): Promise<void> {
    if (!window.confirm("¿Olvidar las cookies de esta sesión?")) return;
    await client.clearCookies();
    setCookieRows([]);
    notify("Cookies olvidadas");
  }

  useEffect(() => {
    const offTick = client.onLoadTick((snap) => {
      setLoad((state) => ({ running: !snap.stopped, snap, points: [...state.points, snap.rps].slice(-90) }));
    });
    const offDone = client.onLoadDone((snap) => {
      setLoad((state) => ({ running: false, snap, points: [...state.points, snap.rps].slice(-90) }));
    });
    return () => {
      offTick();
      offDone();
    };
  }, [client]);

  useEffect(() => {
    if (!workspace) return;
    void client.setTitle(`Omnium — ${workspace.name}`);
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    setSaveLabel("Guardando…");
    const timer = setTimeout(() => {
      void client
        .save(workspace)
        .then(() => setSaveLabel("Guardado"))
        .catch(() => {
          setSaveLabel("No se pudo guardar");
          notify("No se pudo guardar el área de trabajo");
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [workspace, client]);

  useEffect(() => {
    const flush = () => {
      const current = workspaceRef.current;
      if (current) void client.save(current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [client]);

  useEffect(() => {
    if (!workspace) return;
    setTabs((current) => pruneTabs(current, workspace));
    setSelection((current) => pruneSelection(current, workspace));
  }, [workspace]);

  function saveNow(): void {
    const current = workspaceRef.current;
    if (!current) return;
    setSaveLabel("Guardando…");
    void client
      .save(current)
      .then(() => setSaveLabel("Guardado"))
      .catch(() => {
        setSaveLabel("No se pudo guardar");
        notify("No se pudo guardar el área de trabajo");
      });
  }

  /** Cambia el área activa: workspace, selección y toda la sesión de ejecución. */
  function adopt(next: Workspace, nextDir: string | null, persist = false): void {
    if (!persist) hydrated.current = false;
    setWorkspace(next);
    setDir(nextDir);
    setResults({});
    setReport(null);
    setRuntime({});
    const picked = defaultSelection(next);
    setSelection(picked);
    const tab = toTab(picked);
    setTabs(tab ? [tab] : []);
  }

  async function openArea(): Promise<void> {
    const opened = await client.open();
    if (opened) adopt(opened.workspace, opened.dir);
  }

  async function createArea(): Promise<void> {
    const created = await client.create();
    if (created) adopt(created.workspace, created.dir);
  }

  async function exportArea(): Promise<void> {
    if (!workspace) return;
    const secrets = hasSecrets(workspace);
    const done = await client.exportFile(maskWorkspace(workspace));
    if (done) notify(secrets ? "Área exportada · secretos enmascarados" : "Área exportada");
  }

  // --- selección y pestañas ---

  function choose(next: Selection): void {
    setSelection(next);
    if (next.kind === "request") setTabs((current) => openTab(current, next));
  }

  function closeTab(requestId: string): void {
    const closed = closeTabAt(tabs, selection, requestId);
    setTabs(closed.tabs);
    if (closed.selection !== undefined) setSelection(closed.selection);
  }

  // --- colecciones, peticiones y ambientes ---

  function createCollection(): void {
    if (!workspace) return;
    const next = appendCollection(workspace);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function createRequestIn(collectionId: string): void {
    if (!workspace) return;
    const next = appendRequest(workspace, collectionId);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function deleteCollection(collectionId: string): void {
    if (!workspace) return;
    if (!window.confirm("¿Eliminar esta colección?")) return;
    setWorkspace(removeCollection(workspace, collectionId));
  }

  function deleteRequest(collectionId: string, requestId: string): void {
    if (!window.confirm("¿Eliminar esta petición?")) return;
    setWorkspace((current) => (current ? removeRequestIn(current, collectionId, requestId) : current));
    closeTab(requestId);
  }

  function duplicateRequestIn(collectionId: string, requestId: string): void {
    if (!workspace) return;
    const next = duplicateRequest(workspace, collectionId, requestId);
    if (!next) return;
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function moveRequest(collectionId: string, requestId: string, delta: number): void {
    setWorkspace((current) => (current ? moveRequestIn(current, collectionId, requestId, delta) : current));
  }

  function updateRequest(collectionId: string, request: Parameters<typeof updateRequestIn>[2]): void {
    setWorkspace((current) => (current ? updateRequestIn(current, collectionId, request) : current));
  }

  function createEnvironment(): void {
    if (!workspace) return;
    const next = appendEnvironment(workspace);
    setWorkspace(next.workspace);
    setSelection(next.selection);
  }

  function deleteEnvironment(environmentId: string): void {
    if (!workspace) return;
    const next = removeEnvironment(workspace, environmentId);
    if (!next) {
      notify("Deja al menos un ambiente");
      return;
    }
    setWorkspace(next);
    setSelection(null);
  }

  function updateEnvironment(environment: Parameters<typeof updateEnvironmentIn>[1]): void {
    if (!workspace) return;
    setWorkspace(updateEnvironmentIn(workspace, environment));
  }

  // --- ejecución y carga ---

  function remember(request: Parameters<typeof historyEntry>[0], result: ExecutionResult): void {
    setWorkspace((current) => (current ? withHistory(current, historyEntry(request, result)) : current));
  }

  async function send(asTest = false): Promise<void> {
    if (!workspace || selected?.kind !== "request" || busy.current) return;
    busy.current = true;
    setPending(true);
    setPane(asTest ? "tests" : "response");
    try {
      const environment = activeEnvironment(workspace);
      const result = await client.execute({
        request: selected.request,
        variables,
        ...externalHooks(selected.collection, environment),
        environment: environment?.variables,
        moduleDir: dir,
      });
      setResults((current) => ({ ...current, [selected.request.id]: result }));
      setRuntime((current) => ({ ...current, ...result.extracted }));
      remember(selected.request, result);
      applyEnv(environment?.id, result.environmentChanged);
      if (result.error) notify(result.error);
      void refreshCookies();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo enviar";
      setResults((current) => ({ ...current, [selected.request.id]: failedResult(selected.request, message) }));
      notify(message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  /** Los scripts que escribieron en el ambiente lo devuelven como diff. */
  function applyEnv(environmentId: string | undefined, changes: Record<string, string> | undefined): void {
    if (!environmentId || !changes || Object.keys(changes).length === 0) return;
    setWorkspace((current) => (current ? applyEnvironmentChanges(current, environmentId, changes) : current));
  }

  async function testCollection(collectionId: string): Promise<void> {
    if (!workspace || busy.current) return;
    const collection = workspace.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    busy.current = true;
    setPending(true);
    setPane("tests");
    try {
      const environment = activeEnvironment(workspace);
      const runVars = resolveVariables(environment, runtime, {
        globals: workspace.globals,
        collection: collection.variables,
      });
      const next = await client.run({
        requests: collection.requests,
        variables: runVars,
        ...externalHooks(collection, environment),
        environment: environment?.variables,
        moduleDir: dir,
      });
      const fresh: Record<string, ExecutionResult> = {};
      for (const step of next.steps) fresh[step.requestId] = step.result;
      setResults((current) => ({ ...current, ...fresh }));
      setReport({ collectionId, report: next });
      setRuntime((current) => ({ ...current, ...diffVars(runVars, next.variables) }));
      applyEnv(environment?.id, next.environmentChanged);
      const cancelled = next.steps.some((step) => step.result.error === "Petición cancelada");
      notify(cancelled ? "Prueba cancelada" : next.failed ? `${next.failed} peticiones fallaron` : `${next.passed} peticiones bien`);
      void refreshCookies();
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo probar la colección");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function startLoad(): Promise<void> {
    if (selected?.kind !== "request" || load.running || busy.current) return;
    setPane("load");
    setLoad({ running: true, points: [], snap: null });
    try {
      const snap = await client.startLoad({ request: selected.request, variables, plan });
      setLoad((state) => ({ running: false, snap, points: state.points }));
    } catch (error) {
      setLoad((state) => ({ ...state, running: false }));
      notify(error instanceof Error ? error.message : "La carga no arrancó");
    }
  }

  // --- chrome de la interfaz ---

  const [modal, setModal] = useState<Modal>(null);
  const [compact, setCompact] = useState(false);
  const [sideW, setSideW] = useState(286);
  const [outW, setOutW] = useState(430);
  const [curlText, setCurlText] = useState("");
  const [query, setQuery] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const importKind = useRef<"area" | "postman">("area");
  const commandKey = client.platform === "darwin" ? "⌘" : "Ctrl+";

  const sendRef = useRef<(asTest?: boolean) => void>(() => undefined);
  sendRef.current = (asTest) => void send(asTest);
  const modalRef = useRef(modal);
  modalRef.current = modal;

  useEffect(() => {
    document.body.classList.toggle("is-desktop", client.desktop);
    document.body.dataset.platform = client.platform;
  }, [client]);

  useEffect(() => {
    const offMenu = client.onMenu((action) => {
      if (action === "new") void createArea();
      if (action === "open") void openArea();
    });
    return () => {
      offMenu();
    };
  }, [client]);

  useEffect(() => {
    const fit = () => {
      const narrow = window.innerWidth < 980;
      setCompact(narrow);
      if (narrow) return;
      const room = window.innerWidth - 24;
      const side = Math.min(280, Math.max(220, Math.round(room * 0.22)));
      const out = Math.min(460, Math.max(300, room - side - 460));
      setSideW(side);
      setOutW(out);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape" && modalRef.current) {
        event.preventDefault();
        setModal(null);
        return;
      }
      if (!meta) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setModal((current) => (current === "palette" ? null : "palette"));
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNow();
        return;
      }
      if (event.key === "Enter" && !modalRef.current) {
        event.preventDefault();
        sendRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  async function importArea(file: File): Promise<void> {
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      if (importKind.current === "postman") {
        const collection = importPostman(raw);
        setWorkspace((current) => (current ? appendCollectionRaw(current, collection) : current));
        const request = collection.requests[0];
        if (request) choose({ kind: "request", collectionId: collection.id, requestId: request.id });
        notify(`Importada la colección ${collection.name}`);
        return;
      }
      const parsed = parseWorkspace(raw);
      if (!window.confirm("Esto reemplaza colecciones, ambientes e historial de esta área.")) return;
      adopt(parsed, dir, true);
      notify("Área importada");
    } catch (error) {
      notify(error instanceof SyntaxError ? "El archivo no es JSON" : error instanceof Error ? error.message : "No se pudo importar");
    }
  }

  function beginImport(kind: "area" | "postman"): void {
    importKind.current = kind;
    importRef.current?.click();
  }

  function startResize(which: "side" | "out", origin: number, width: number): void {
    const move = (event: MouseEvent) => {
      const delta = event.clientX - origin;
      const room = window.innerWidth - 520;
      if (which === "side") setSideW(Math.min(480, Math.max(220, Math.min(width + delta, room - outW))));
      else setOutW(Math.min(680, Math.max(300, Math.min(width - delta, room - sideW))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  }

  function commands(): Command[] {
    if (!workspace) return [];
    const items: Command[] = [
      { id: "send", label: "Enviar petición", hint: `${commandKey}↩`, run: () => void send() },
      { id: "test", label: "Probar afirmaciones", hint: "Petición actual", run: () => void send(true) },
      { id: "load", label: "Abrir carga", hint: "Usuarios y percentiles", run: () => setPane("load") },
      { id: "code", label: "Generar código", hint: "fetch y Python", run: () => setModal("snippet") },
      { id: "postman", label: "Importar colección Postman", hint: "v2.1", run: () => beginImport("postman") },
      { id: "globals", label: "Variables globales", hint: "Toda el área", run: () => choose({ kind: "globals" }) },
      { id: "cookies", label: "Ver cookies", hint: "Sesión local", run: () => { setModal("cookies"); void refreshCookies(); } },
      { id: "help", label: "Ayuda", hint: "Atajos y ejemplo", run: () => setModal("help") },
    ];
    for (const collection of workspace.collections) {
      items.push({
        id: `vars-${collection.id}`,
        label: `Variables de ${collection.name}`,
        hint: "Colección",
        run: () => choose({ kind: "collection", collectionId: collection.id }),
      });
      for (const request of collection.requests) {
        items.push({
          id: request.id,
          label: request.name,
          hint: `${collection.name} · ${request.method}`,
          run: () => choose({ kind: "request", collectionId: collection.id, requestId: request.id }),
        });
      }
    }
    return items;
  }

  return {
    // workspace
    workspace,
    setWorkspace,
    dir,
    saveLabel,
    saveNow,
    adopt,
    openArea,
    createArea,
    exportArea,
    // selección
    selection,
    setSelection,
    tabs,
    choose,
    closeTab,
    // entidades
    createCollection,
    createRequestIn,
    deleteCollection,
    deleteRequest,
    duplicateRequestIn,
    moveRequest,
    updateRequest,
    createEnvironment,
    deleteEnvironment,
    updateEnvironment,
    // ejecución
    selected,
    variables,
    results,
    report,
    runtime,
    setRuntime,
    pending,
    pane,
    setPane,
    send,
    testCollection,
    // carga
    load,
    plan,
    setPlan,
    startLoad,
    // avisos
    toast,
    notify,
    // cookies
    cookieRows,
    refreshCookies,
    forgetCookies,
    // chrome
    modal,
    setModal,
    compact,
    sideW,
    outW,
    curlText,
    setCurlText,
    query,
    setQuery,
    importRef,
    commandKey,
    importArea,
    beginImport,
    startResize,
    commands,
  };
}
