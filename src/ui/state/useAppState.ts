import { useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../../client.ts";
import type { CookieView } from "../../core/cookies.ts";
import type {
  ExecutionResult,
  LoadPlan,
  LoadSnapshot,
  Workspace,
} from "../../core/types.ts";
import { resolveVariables } from "../../core/variables.ts";
import {
  activeEnvironment,
  appendCollection,
  appendEnvironment,
  appendRequest,
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
    const done = await client.exportFile(workspace);
    if (done) notify("Área exportada");
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
      const result = await client.execute({ request: selected.request, variables });
      setResults((current) => ({ ...current, [selected.request.id]: result }));
      setRuntime((current) => ({ ...current, ...result.extracted }));
      remember(selected.request, result);
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

  async function testCollection(collectionId: string): Promise<void> {
    if (!workspace || busy.current) return;
    const collection = workspace.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    busy.current = true;
    setPending(true);
    setPane("tests");
    try {
      const runVars = resolveVariables(activeEnvironment(workspace), runtime, {
        globals: workspace.globals,
        collection: collection.variables,
      });
      const next = await client.run({ requests: collection.requests, variables: runVars });
      const fresh: Record<string, ExecutionResult> = {};
      for (const step of next.steps) fresh[step.requestId] = step.result;
      setResults((current) => ({ ...current, ...fresh }));
      setReport({ collectionId, report: next });
      setRuntime((current) => ({ ...current, ...diffVars(runVars, next.variables) }));
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
  };
}
