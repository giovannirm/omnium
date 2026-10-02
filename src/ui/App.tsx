import { useMemo, useState } from "react";
import { getClient } from "../client.ts";
import type { CookieView } from "../core/cookies.ts";
import { parseCurl } from "../core/curl.ts";
import { toCurl } from "../core/execute.ts";
import { toFetch, toPython } from "../core/snippets.ts";
import { secretKeys } from "../core/secrets.ts";
import type { Pair, RequestModel } from "../core/types.ts";
import { Editor, EnvironmentEditor } from "./Editor.tsx";
import { Outcome } from "./Outcome.tsx";
import { CommandPalette } from "./palette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { setCollectionVariables, setGlobals, updateCollection } from "./state/model.ts";
import { useAppState } from "./state/useAppState.ts";
import { Mark, PairTable } from "./widgets.tsx";

export function App() {
  const client = useMemo(() => getClient(), []);
  const app = useAppState({ client });
  const {
    workspace,
    setWorkspace,
    dir,
    saveLabel,
    openArea,
    createArea,
    exportArea,
    selection,
    tabs,
    choose,
    closeTab,
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
    load,
    plan,
    setPlan,
    startLoad,
    toast,
    notify,
    cookieRows,
    refreshCookies,
    forgetCookies,
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
  } = app;

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
                onDuplicate={() => duplicateRequestIn(selected.collection.id, selected.request.id)}
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
          secretNames={secretKeys(workspace)}
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
  secretNames,
  onClose,
  onCopy,
}: {
  request: RequestModel;
  variables: Record<string, string>;
  secretNames: string[];
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  const [kind, setKind] = useState<"fetch" | "python" | "curl">("fetch");
  const code = kind === "fetch" ? toFetch(request, variables) : kind === "python" ? toPython(request, variables) : toCurl(request, variables);
  const leaksSecret = secretNames.some((key) => {
    const value = variables[key];
    return Boolean(value) && code.includes(value as string);
  });
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
        {leaksSecret ? (
          <p className="banner">Este código usa valores marcados como secretos. No lo compartas tal cual.</p>
        ) : null}
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
