import { useEffect, useMemo, useRef, useState } from "react";
import { getClient } from "../client.ts";
import type { CookieView } from "../core/cookies.ts";
import { parseCurl } from "../core/curl.ts";
import { parseWorkspace } from "../core/files.ts";
import { importPostman } from "../core/postman.ts";
import { toFetch, toPython } from "../core/snippets.ts";
import { toCurl } from "../core/execute.ts";
import type { Environment, ExecutionResult, LoadPlan, LoadSnapshot, Pair, RequestModel, Workspace } from "../core/types.ts";
import { resolveVariables } from "../core/variables.ts";
import { Editor, EnvironmentEditor } from "./Editor.tsx";
import { Outcome } from "./Outcome.tsx";
import { CommandPalette, type Command } from "./palette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import {
  activeEnvironment,
  appendCollection,
  appendCollectionRaw,
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
  setCollectionVariables,
  setGlobals,
  toTab,
  updateCollection,
  updateEnvironmentIn,
  updateRequestIn,
  withHistory,
  type Selection,
  type Tab,
} from "./state/model.ts";
import { Mark, PairTable } from "./widgets.tsx";

type LoadState = { running: boolean; points: number[]; snap: LoadSnapshot | null };

export function App() {
  const client = useMemo(() => getClient(), []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [results, setResults] = useState<Record<string, ExecutionResult>>({});
  const [report, setReport] = useState<{ collectionId: string; report: Awaited<ReturnType<typeof client.run>> } | null>(null);
  const [pane, setPane] = useState<"response" | "tests" | "load">("response");
  const [load, setLoad] = useState<LoadState>({ running: false, points: [], snap: null });
  const [plan, setPlan] = useState<LoadPlan>({
    concurrency: 10,
    rampUpMs: 1000,
    durationMs: 8000,
    timeoutMs: 5000,
    pauseMs: 0,
    maxErrorPct: 1,
    maxP95Ms: 500,
  });
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "help" | "curl" | "palette" | "snippet" | "cookies">(null);
  const [compact, setCompact] = useState(false);
  const [cookieRows, setCookieRows] = useState<CookieView[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [sideW, setSideW] = useState(286);
  const [outW, setOutW] = useState(430);
  const [curlText, setCurlText] = useState("");
  const [saveLabel, setSaveLabel] = useState("Listo");
  const [query, setQuery] = useState("");
  const [runtime, setRuntime] = useState<Record<string, string>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const importKind = useRef<"area" | "postman">("area");
  const hydrated = useRef(false);
  const busy = useRef(false);
  const sendRef = useRef<() => void>(() => undefined);
  const modalRef = useRef(modal);
  const workspaceRef = useRef(workspace);
  const notifyRef = useRef<(message: string) => void>(() => undefined);
  const commandKey = client.platform === "darwin" ? "⌘" : "Ctrl+";

  useEffect(() => {
    document.body.classList.toggle("is-desktop", client.desktop);
    document.body.dataset.platform = client.platform;
    let live = true;
    void client.load().then((loaded) => {
      if (!live) return;
      setWorkspace(loaded.workspace);
      setDir(loaded.dir);
      const next = defaultSelection(loaded.workspace);
      if (next) {
        setSelection(next);
        const tab = toTab(next);
        if (tab) setTabs([tab]);
      }
      if (loaded.warning) {
        setToast(loaded.warning);
        window.setTimeout(() => setToast((current) => (current === loaded.warning ? null : current)), 5200);
      }
      void refreshCookies();
    });
    return () => {
      live = false;
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
    const offTick = client.onLoadTick((snap) => {
      setLoad((state) => ({ running: !snap.stopped, snap, points: [...state.points, snap.rps].slice(-90) }));
    });
    const offDone = client.onLoadDone((snap) => {
      setLoad((state) => ({ running: false, snap, points: [...state.points, snap.rps].slice(-90) }));
    });
    const offMenu = client.onMenu((action) => {
      if (action === "new") void createArea();
      if (action === "open") void openArea();
    });
    return () => {
      offTick();
      offDone();
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
        const current = workspaceRef.current;
        if (!current) return;
        setSaveLabel("Guardando…");
        void client
          .save(current)
          .then(() => setSaveLabel("Guardado"))
          .catch(() => {
            setSaveLabel("No se pudo guardar");
            notifyRef.current("No se pudo guardar el área de trabajo");
          });
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

  useEffect(() => {
    if (!workspace) return;
    setTabs((current) => pruneTabs(current, workspace));
    setSelection((current) => pruneSelection(current, workspace));
  }, [workspace]);

  useEffect(() => {
    const flush = () => {
      const current = workspaceRef.current;
      if (current) void client.save(current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [client]);

  const selected = useMemo(() => locate(workspace, selection), [workspace, selection]);
  const environment = activeEnvironment(workspace);
  const activeCollection = selected && "collection" in selected ? selected.collection : null;
  const variables = resolveVariables(environment, runtime, {
    globals: workspace?.globals ?? [],
    collection: activeCollection?.variables ?? [],
  });

  sendRef.current = () => {
    void send();
  };
  modalRef.current = modal;
  workspaceRef.current = workspace;
  notifyRef.current = notify;

  if (!workspace) {
    return (
      <div className="boot">
        <Mark />
        <p>Abriendo Omnium…</p>
      </div>
    );
  }

  return (
    <div className="app" aria-busy={pending}>
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div>
            <strong>Omnium</strong>
            <small>cliente, prueba y carga</small>
          </div>
        </div>
        <div className="top-actions">
          <label className="field inline">
            Ambiente
            <select
              value={workspace.activeEnvironmentId ?? ""}
              onChange={(event) => setWorkspace({ ...workspace, activeEnvironmentId: event.target.value })}
            >
              {workspace.environments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <span className="save-state" role="status">
            {saveLabel}
          </span>
          {pending ? (
            <button type="button" className="ghost danger" onClick={() => void client.cancelHttp()}>
              Cancelar
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setModal("cookies");
              void refreshCookies();
            }}
          >
            Cookies{cookieRows.length ? ` ${cookieRows.length}` : ""}
          </button>
          <button type="button" className="ghost" onClick={() => void exportArea()}>
            Exportar
          </button>
          <button type="button" className="ghost" onClick={() => beginImport("area")}>
            Importar
          </button>
          <button type="button" className="ghost" onClick={() => beginImport("postman")}>
            Postman
          </button>
          <button type="button" className="ghost command" onClick={() => setModal("palette")}>
            Buscar <kbd>{commandKey}K</kbd>
          </button>
          {client.desktop ? (
            <>
              <button type="button" className="ghost" onClick={() => void openArea()}>
                Abrir
              </button>
              <button type="button" className="ghost" onClick={() => void createArea()}>
                Nueva
              </button>
            </>
          ) : null}
          <button type="button" className="ghost" onClick={() => setModal("help")}>
            Ayuda
          </button>
        </div>
      </header>
      <div
        className={compact ? "workspace compact" : "workspace"}
        style={compact ? undefined : { gridTemplateColumns: `${sideW}px 8px minmax(0, 1fr) 8px ${outW}px` }}
      >
        <Sidebar
          workspace={workspace}
          selection={selection}
          query={query}
          results={results}
          onQuery={setQuery}
          onSelect={choose}
          onCreateCollection={createCollection}
          onCreateRequest={createRequestIn}
          onRenameCollection={(collectionId, name) =>
            setWorkspace(updateCollection(workspace, collectionId, (collection) => ({ ...collection, name })))
          }
          onDeleteCollection={deleteCollection}
          onTestCollection={(collectionId) => void testCollection(collectionId)}
          onCreateEnvironment={createEnvironment}
        />
        <div className="resizer" onMouseDown={(event) => { event.preventDefault(); startResize("side", event.clientX, sideW); }} />
        <div className="stage-wrap">
          <div className="request-tabs" role="tablist" aria-label="Peticiones abiertas">
            {tabs.map((tab) => {
              const request = workspace.collections.flatMap((collection) => collection.requests).find((item) => item.id === tab.requestId);
              const active = selection?.kind === "request" && selection.requestId === tab.requestId;
              return (
                <div key={tab.requestId} className={active ? "request-tab active" : "request-tab"} role="tab" aria-selected={active}>
                  <button
                    type="button"
                    className="request-tab-main"
                    onClick={() => choose({ kind: "request", collectionId: tab.collectionId, requestId: tab.requestId })}
                  >
                    <span className={`method method-${request?.method ?? "GET"}`}>{request?.method ?? ""}</span>
                    {request?.name ?? "Petición"}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`Cerrar ${request?.name ?? "pestaña"}`}
                    onClick={() => closeTab(tab.requestId)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {selected?.kind === "request" ? (
            <Editor
              key={selected.request.id}
              request={selected.request}
              variables={variables}
              runtime={runtime}
              pending={pending}
              onChange={(request) => updateRequest(selected.collection.id, request)}
              onSend={() => void send()}
              onCancel={() => void client.cancelHttp()}
              onTest={() => void send(true)}
              onSnippet={() => setModal("snippet")}
              onNotice={notify}
              onCurl={() => {
                setCurlText("");
                setModal("curl");
              }}
              onDelete={() => deleteRequest(selected.collection.id, selected.request.id)}
                onDuplicate={() => duplicateRequestIn(selected.collection.id, selected.request)}
              onMove={(delta) => moveRequest(selected.collection.id, selected.request.id, delta)}
              onClearRuntime={() => setRuntime({})}
            />
          ) : selected?.kind === "environment" ? (
            <EnvironmentEditor
              environment={selected.environment}
              active={selected.environment.id === workspace.activeEnvironmentId}
              onChange={(environment) => updateEnvironment(environment)}
              onUse={() => setWorkspace({ ...workspace, activeEnvironmentId: selected.environment.id })}
              onDelete={() => deleteEnvironment(selected.environment.id)}
            />
          ) : selected?.kind === "globals" ? (
            <VariableStage
              title="Variables globales"
              hint="Valen en todas las colecciones. Un ambiente o la colección pueden reemplazarlas."
              rows={workspace.globals}
              onChange={(globals) => setWorkspace(setGlobals(workspace, globals))}
            />
          ) : selected?.kind === "collection" ? (
            <VariableStage
              title={selected.collection.name}
              hint="Estas variables viven en la colección y pisan a las del ambiente."
              rows={selected.collection.variables}
              onChange={(rows) => setWorkspace(setCollectionVariables(workspace, selected.collection.id, rows))}
            />
          ) : (
            <section className="stage empty-stage">
              <h2 className="empty-title">No hay una petición abierta</h2>
              <p className="hint">
                {workspace.collections.length
                  ? "Elige una en la barra lateral o crea una nueva."
                  : "Crea una colección para guardar la primera petición."}
              </p>
              <button
                type="button"
                className="send"
                onClick={() => {
                  const collection = workspace.collections[0];
                  if (collection) createRequestIn(collection.id);
                  else createCollection();
                }}
              >
                {workspace.collections.length ? "Nueva petición" : "Nueva colección"}
              </button>
            </section>
          )}
        </div>
        <div className="resizer" onMouseDown={(event) => { event.preventDefault(); startResize("out", event.clientX, outW); }} />
        <Outcome
          pane={pane}
          onPane={setPane}
          result={selected?.kind === "request" ? (results[selected.request.id] ?? null) : null}
          report={report && selected?.kind === "request" && report.collectionId === selected.collection.id ? report : null}
          load={load}
          plan={plan}
          onPlan={setPlan}
          onStart={() => void startLoad()}
          onStop={() => void client.stopLoad()}
          busy={pending}
          onPickStep={(requestId) => {
            if (!report) return;
            choose({ kind: "request", collectionId: report.collectionId, requestId });
            setPane("response");
          }}
          onCopy={(text) =>
            void navigator.clipboard.writeText(text).then(
              () => notify("Copiado"),
              () => notify("No se pudo copiar"),
            )
          }
        />
      </div>
      <footer className="foot">
        <input
          className="workspace-name"
          value={workspace.name}
          aria-label="Nombre del área"
          onChange={(event) => setWorkspace({ ...workspace, name: event.target.value })}
        />
        {dir ? (
          <button type="button" className="path" onClick={() => void client.reveal()}>
            {dir}
          </button>
        ) : (
          <span className="path">Guardado en este navegador</span>
        )}
      </footer>
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importArea(file);
        }}
      />
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      {modal === "palette" ? <CommandPalette commands={commands()} onClose={() => setModal(null)} /> : null}
      {modal === "snippet" && selected?.kind === "request" ? (
        <SnippetModal
          request={selected.request}
          variables={variables}
          onClose={() => setModal(null)}
          onCopy={(text) =>
            void navigator.clipboard.writeText(text).then(
              () => notify("Código copiado"),
              () => notify("No se pudo copiar"),
            )
          }
        />
      ) : null}
      {modal === "help" ? <Help modifier={commandKey} onClose={() => setModal(null)} /> : null}
      {modal === "cookies" ? (
        <CookiesDialog
          rows={cookieRows}
          onClose={() => setModal(null)}
          onClear={() => void forgetCookies()}
        />
      ) : null}
      {modal === "curl" && selected?.kind === "request" ? (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="curl-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="curl-title">Pegar cURL</h2>
            <textarea className="code-input" value={curlText} onChange={(event) => setCurlText(event.target.value)} placeholder="curl https://..." />
            <div className="toolbar">
              <button
                type="button"
                className="send"
                onClick={() => {
                  const parsed = parseCurl(curlText);
                  if (!parsed.url) {
                    notify("El cURL no tiene una URL");
                    return;
                  }
                  updateRequest(selected.collection.id, { ...selected.request, ...parsed, id: selected.request.id, name: selected.request.name });
                  setModal(null);
                  notify("cURL aplicado");
                }}
              >
                Aplicar
              </button>
              <button type="button" className="ghost" onClick={() => setModal(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  async function send(asTest = false) {
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

  async function testCollection(collectionId: string) {
    if (!workspace || busy.current) return;
    const collection = workspace.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    busy.current = true;
    setPending(true);
    setPane("tests");
    try {
      const runVars = resolveVariables(
        workspace.environments.find((item) => item.id === workspace.activeEnvironmentId) ?? null,
        runtime,
        { globals: workspace.globals, collection: collection.variables },
      );
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

  async function startLoad() {
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

  function remember(request: RequestModel, result: ExecutionResult) {
    setWorkspace((current) => (current ? withHistory(current, historyEntry(request, result)) : current));
  }

  function createCollection() {
    if (!workspace) return;
    const next = appendCollection(workspace);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function createRequestIn(collectionId: string) {
    if (!workspace) return;
    const next = appendRequest(workspace, collectionId);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function deleteCollection(collectionId: string) {
    if (!workspace) return;
    if (!window.confirm("¿Eliminar esta colección?")) return;
    setWorkspace(removeCollection(workspace, collectionId));
  }

  function deleteRequest(collectionId: string, requestId: string) {
    if (!window.confirm("¿Eliminar esta petición?")) return;
    setWorkspace((current) => (current ? removeRequestIn(current, collectionId, requestId) : current));
    closeTab(requestId);
  }

  function duplicateRequestIn(collectionId: string, request: RequestModel) {
    if (!workspace) return;
    const next = duplicateRequest(workspace, collectionId, request.id);
    if (!next) return;
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function moveRequest(collectionId: string, requestId: string, delta: number) {
    setWorkspace((current) => (current ? moveRequestIn(current, collectionId, requestId, delta) : current));
  }

  function createEnvironment() {
    if (!workspace) return;
    const next = appendEnvironment(workspace);
    setWorkspace(next.workspace);
    setSelection(next.selection);
  }

  function deleteEnvironment(environmentId: string) {
    if (!workspace) return;
    const next = removeEnvironment(workspace, environmentId);
    if (!next) {
      notify("Deja al menos un ambiente");
      return;
    }
    setWorkspace(next);
    setSelection(null);
  }

  function updateRequest(collectionId: string, request: RequestModel) {
    setWorkspace((current) => (current ? updateRequestIn(current, collectionId, request) : current));
  }

  function updateEnvironment(environment: Environment) {
    if (!workspace) return;
    setWorkspace(updateEnvironmentIn(workspace, environment));
  }

  async function openArea() {
    const opened = await client.open();
    if (!opened) return;
    adopt(opened.workspace, opened.dir);
  }

  async function createArea() {
    const created = await client.create();
    if (!created) return;
    adopt(created.workspace, created.dir);
  }

  async function exportArea() {
    if (!workspace) return;
    const done = await client.exportFile(workspace);
    if (done) notify("Área exportada");
  }

  async function importArea(file: File) {
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

  function choose(next: Selection) {
    setSelection(next);
    if (next.kind === "request") setTabs((current) => openTab(current, next));
  }

  function closeTab(requestId: string) {
    const closed = closeTabAt(tabs, selection, requestId);
    setTabs(closed.tabs);
    if (closed.selection !== undefined) setSelection(closed.selection);
  }

  function beginImport(kind: "area" | "postman") {
    importKind.current = kind;
    importRef.current?.click();
  }

  function startResize(which: "side" | "out", origin: number, width: number) {
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

  function adopt(next: Workspace, nextDir: string | null, persist = false) {
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

  async function refreshCookies() {
    try {
      setCookieRows(await client.listCookies());
    } catch {
      return;
    }
  }

  async function forgetCookies() {
    if (!window.confirm("¿Olvidar las cookies de esta sesión?")) return;
    await client.clearCookies();
    setCookieRows([]);
    notify("Cookies olvidadas");
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  }
}

function CookiesDialog({ rows, onClose, onClear }: { rows: CookieView[]; onClose: () => void; onClear: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="cookies-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="cookies-title">Cookies</h2>
        <p className="hint">Viven en esta sesión y no se guardan en el área de trabajo. Solo viajan al mismo host, camino y esquema.</p>
        {rows.length === 0 ? <p className="hint">Todavía no hay cookies. Las que devuelva una respuesta se usarán en la siguiente petición.</p> : null}
        <ul className="cookie-list">
          {rows.map((cookie) => (
            <li key={`${cookie.host}|${cookie.name}|${cookie.path}|${cookie.hostOnly ? "host" : "domain"}`}>
              <div className="cookie-top">
                <strong>{cookie.name}</strong>
                <span>{cookie.hostOnly ? cookie.host : `${cookie.host} y subdominios`}</span>
              </div>
              <code>{show ? cookie.value : maskCookie(cookie.value)}</code>
              <small>
                {cookie.path}
                {cookie.secure ? " · segura" : ""} · {cookie.expiresAt === null ? "sesión" : new Date(cookie.expiresAt).toLocaleString("es")}
              </small>
            </li>
          ))}
        </ul>
        <div className="toolbar">
          <button type="button" className="ghost" onClick={() => setShow((current) => !current)} disabled={rows.length === 0}>
            {show ? "Ocultar valores" : "Mostrar valores"}
          </button>
          <button type="button" className="ghost danger" onClick={onClear} disabled={rows.length === 0}>
            Olvidar
          </button>
          <button type="button" className="send" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function maskCookie(value: string): string {
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function VariableStage({
  title,
  hint,
  rows,
  onChange,
}: {
  title: string;
  hint: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
}) {
  return (
    <section className="stage">
      <h2 className="request-title">{title}</h2>
      <p className="hint">{hint}</p>
      <PairTable rows={rows} keyPlaceholder="nombre" valuePlaceholder="valor" onChange={onChange} />
    </section>
  );
}

function SnippetModal({
  request,
  variables,
  onClose,
  onCopy,
}: {
  request: RequestModel;
  variables: Record<string, string>;
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  const [kind, setKind] = useState<"fetch" | "python" | "curl">("fetch");
  const code = kind === "fetch" ? toFetch(request, variables) : kind === "python" ? toPython(request, variables) : toCurl(request, variables);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="snippet-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="snippet-title">Código</h2>
        <div className="toolbar">
          <button type="button" className={kind === "fetch" ? "tab active" : "tab"} onClick={() => setKind("fetch")}>
            fetch
          </button>
          <button type="button" className={kind === "python" ? "tab active" : "tab"} onClick={() => setKind("python")}>
            Python
          </button>
          <button type="button" className={kind === "curl" ? "tab active" : "tab"} onClick={() => setKind("curl")}>
            cURL
          </button>
        </div>
        <pre className="code">{code}</pre>
        <div className="toolbar">
          <button type="button" className="send" onClick={() => onCopy(code)}>
            Copiar
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function Help({ modifier, onClose }: { modifier: string; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="help-title">Omnium</h2>
        <p>Una sola aplicación para llamar una API, guardarla en archivos, probarla y cargarla.</p>
        <ul>
          <li>{modifier}K abre el buscador. {modifier}↩ envía la petición. {modifier}S guarda ahora. Esc cierra esta ventana.</li>
          <li>Cancelar corta la petición o la prueba de la colección que esté en curso.</li>
          <li>Variables en capas: globales, ambiente, colección y las extraídas en la corrida.</li>
          <li>Importa colecciones Postman v2.1 y genera fetch, Python o cURL.</li>
          <li>Las cookies de la sesión se ven en Cookies y no se escriben en el área.</li>
          <li>La carga compara errores y p95 contra los límites que marques.</li>
        </ul>
        <p>El ejemplo escucha en el puerto 4321. Desde la carpeta omnium: npm run demo</p>
        <p>Para abrir la ventana de escritorio: npm run desktop</p>
        <button type="button" className="send" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
