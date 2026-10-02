import { useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../../client.ts";
import type { CookieView } from "../../core/cookies.ts";
import type { ExecutionResult, LoadPlan, Workspace } from "../../core/types.ts";
import { resolveVariables } from "../../core/variables.ts";
import type { Selection, Tab } from "./model.ts";
import { activeEnvironment, defaultSelection, locate, pruneSelection, pruneTabs, toTab } from "./model.ts";
import type { LoadState, Pane, SessionReport } from "./executionActions.ts";
import { DEFAULT_PLAN } from "./executionActions.ts";
import type { Modal } from "./chromeActions.ts";
import { createWorkspaceActions } from "./workspaceActions.ts";
import { createExecutionActions } from "./executionActions.ts";
import { createChromeActions } from "./chromeActions.ts";

export type { Modal } from "./chromeActions.ts";
export type { Pane, LoadState, SessionReport } from "./executionActions.ts";

export type AppState = ReturnType<typeof useAppState>;

/**
 * Capa de estado de la aplicación. Toda la orquestación vive acá: la UI solo
 * compone y renderiza. El hook declara el estado, los efectos y las
 * derivaciones; las acciones viven por dominio en `workspaceActions`
 * (persistencia, selección y entidades), `executionActions` (envío, pruebas
 * y carga) y `chromeActions` (paleta y paneles).
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

  // --- carga ---
  const [load, setLoad] = useState<LoadState>({ running: false, points: [], snap: null });
  const [plan, setPlan] = useState<LoadPlan>(DEFAULT_PLAN);

  // --- avisos ---
  const [toast, setToast] = useState<string | null>(null);

  // --- cookies de sesión ---
  const [cookieRows, setCookieRows] = useState<CookieView[]>([]);

  // --- chrome de la interfaz ---
  const [modal, setModal] = useState<Modal>(null);
  const [compact, setCompact] = useState(false);
  const [sideW, setSideW] = useState(286);
  const [outW, setOutW] = useState(430);
  const [curlText, setCurlText] = useState("");
  const [query, setQuery] = useState("");

  const selected = useMemo(() => locate(workspace, selection), [workspace, selection]);
  const environment = activeEnvironment(workspace);
  const activeCollection = selected && "collection" in selected ? selected.collection : null;
  const variables = resolveVariables(environment, runtime, {
    globals: workspace?.globals ?? [],
    collection: activeCollection?.variables ?? [],
  });
  const commandKey = client.platform === "darwin" ? "⌘" : "Ctrl+";

  function notify(message: string, ms = 3200): void {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), ms);
  }

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

  // --- acciones por dominio ---
  const ws = createWorkspaceActions({
    client,
    workspace,
    dir,
    selection,
    tabs,
    setWorkspace,
    setSelection,
    setTabs,
    setDir,
    setSaveLabel,
    setResults,
    setReport,
    setRuntime,
    notify,
  });
  const ex = createExecutionActions({
    client,
    workspace,
    dir,
    selection,
    variables,
    runtime,
    load,
    plan,
    setWorkspace,
    setResults,
    setReport,
    setRuntime,
    setPending,
    setPane,
    setLoad,
    notify,
    refreshCookies,
  });
  const chrome = createChromeActions({
    workspace,
    commandKey,
    sideW,
    outW,
    setSideW,
    setOutW,
    setPane,
    setModal,
    choose: ws.choose,
    send: ex.send,
    beginImport: ws.beginImport,
    refreshCookies,
  });

  const sendRef = useRef<(asTest?: boolean) => void>(() => undefined);
  sendRef.current = (asTest) => void ex.send(asTest);
  const modalRef = useRef(modal);
  modalRef.current = modal;

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
    if (!ws.hydrated.current) {
      ws.hydrated.current = true;
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
      const current = ws.workspaceRef.current;
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

  useEffect(() => {
    document.body.classList.toggle("is-desktop", client.desktop);
    document.body.dataset.platform = client.platform;
  }, [client]);

  useEffect(() => {
    const offMenu = client.onMenu((action) => {
      if (action === "new") void ws.createArea();
      if (action === "open") void ws.openArea();
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
        ws.saveNow();
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

  return {
    // workspace
    workspace,
    setWorkspace,
    dir,
    saveLabel,
    saveNow: ws.saveNow,
    adopt: ws.adopt,
    openArea: ws.openArea,
    createArea: ws.createArea,
    exportArea: ws.exportArea,
    // selección
    selection,
    setSelection,
    tabs,
    choose: ws.choose,
    closeTab: ws.closeTab,
    // entidades
    createCollection: ws.createCollection,
    createRequestIn: ws.createRequestIn,
    deleteCollection: ws.deleteCollection,
    deleteRequest: ws.deleteRequest,
    duplicateRequestIn: ws.duplicateRequestIn,
    moveRequest: ws.moveRequest,
    updateRequest: ws.updateRequest,
    createEnvironment: ws.createEnvironment,
    deleteEnvironment: ws.deleteEnvironment,
    updateEnvironment: ws.updateEnvironment,
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
    send: ex.send,
    testCollection: ex.testCollection,
    // carga
    load,
    plan,
    setPlan,
    startLoad: ex.startLoad,
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
    importRef: ws.importRef,
    commandKey,
    importArea: ws.importArea,
    beginImport: ws.beginImport,
    startResize: chrome.startResize,
    commands: chrome.commands,
  };
}
