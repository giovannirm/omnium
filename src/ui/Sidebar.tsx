import type { Workspace } from "../core/types.ts";
import { stepPassed } from "../core/assertions.ts";
import type { ExecutionResult } from "../core/types.ts";
import { formatWhen } from "./widgets.tsx";

export type Selection =
  | { kind: "request"; collectionId: string; requestId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "globals" }
  | { kind: "collection"; collectionId: string };

export function Sidebar({
  workspace,
  selection,
  query,
  results,
  onQuery,
  onSelect,
  onCreateCollection,
  onCreateRequest,
  onRenameCollection,
  onDeleteCollection,
  onTestCollection,
  onCreateEnvironment,
}: {
  workspace: Workspace;
  selection: Selection | null;
  query: string;
  results: Record<string, ExecutionResult>;
  onQuery: (value: string) => void;
  onSelect: (selection: Selection) => void;
  onCreateCollection: () => void;
  onCreateRequest: (collectionId: string) => void;
  onRenameCollection: (collectionId: string, name: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onTestCollection: (collectionId: string) => void;
  onCreateEnvironment: () => void;
}) {
  const needle = query.trim().toLowerCase();
  const anyMatch = workspace.collections.some((collection) =>
    collection.requests.some(
      (request) => !needle || request.name.toLowerCase().includes(needle) || request.url.toLowerCase().includes(needle),
    ),
  );
  return (
    <aside className="sidebar">
      <div className="side-scroll">
        <label className="search">
          <span className="sr">Buscar</span>
          <input value={query} placeholder="Buscar petición" onChange={(event) => onQuery(event.target.value)} />
        </label>
        <div className="side-label">
          <span>Colecciones</span>
          <button type="button" className="icon" onClick={onCreateCollection} aria-label="Nueva colección">
            +
          </button>
        </div>
        {workspace.collections.map((collection) => {
          const requests = collection.requests.filter((request) => {
            if (!needle) return true;
            return request.name.toLowerCase().includes(needle) || request.url.toLowerCase().includes(needle);
          });
          if (needle && requests.length === 0) return null;
          return (
            <section className="collection" key={collection.id}>
              <div className="collection-head">
                <input
                  className="rename"
                  value={collection.name}
                  aria-label="Nombre de la colección"
                  onChange={(event) => onRenameCollection(collection.id, event.target.value)}
                />
                <button type="button" className="icon" aria-label="Variables de la colección" title="Variables" onClick={() => onSelect({ kind: "collection", collectionId: collection.id })}>
                  v
                </button>
                <button type="button" className="icon" aria-label="Probar colección" title="Probar colección" onClick={() => onTestCollection(collection.id)}>
                  ▶
                </button>
                <button type="button" className="icon" aria-label="Nueva petición" title="Nueva petición" onClick={() => onCreateRequest(collection.id)}>
                  +
                </button>
                <button type="button" className="icon" aria-label="Eliminar colección" title="Eliminar colección" onClick={() => onDeleteCollection(collection.id)}>
                  ×
                </button>
              </div>
              {requests.map((request) => {
                const active = selection?.kind === "request" && selection.requestId === request.id;
                const result = results[request.id];
                return (
                  <button
                    type="button"
                    key={request.id}
                    className={active ? "request-row active" : "request-row"}
                    onClick={() => onSelect({ kind: "request", collectionId: collection.id, requestId: request.id })}
                  >
                    <span className={`method method-${request.method}`}>{request.method}</span>
                    <span className="request-name">{request.name}</span>
                    {result ? <i className={stepPassed(result) ? "dot ok" : "dot bad"} /> : null}
                  </button>
                );
              })}
            </section>
          );
        })}
        {needle && !anyMatch ? <p className="hint">Ninguna petición coincide.</p> : null}
        {!needle && workspace.collections.length === 0 ? <p className="hint">Todavía no hay colecciones.</p> : null}
        <div className="side-label">
          <span>Ambientes</span>
          <button type="button" className="icon" onClick={onCreateEnvironment} aria-label="Nuevo ambiente">
            +
          </button>
        </div>
        <button type="button" className={selection?.kind === "globals" ? "env-row active" : "env-row"} onClick={() => onSelect({ kind: "globals" })}>
          <span>Globales</span>
        </button>
        {workspace.environments.map((environment) => (
          <button
            type="button"
            key={environment.id}
            className={
              selection?.kind === "environment" && selection.environmentId === environment.id ? "env-row active" : "env-row"
            }
            onClick={() => onSelect({ kind: "environment", environmentId: environment.id })}
          >
            <span>{environment.name}</span>
            {workspace.activeEnvironmentId === environment.id ? <small>activo</small> : null}
          </button>
        ))}
        <div className="side-label">
          <span>Historial</span>
        </div>
        {workspace.history.length === 0 ? <p className="hint">Todavía no envías nada.</p> : null}
        {workspace.history.slice(0, 12).map((entry) => {
          const collection = workspace.collections.find((item) => item.requests.some((request) => request.id === entry.requestId));
          const tone = !entry.ok || entry.status === null || entry.status >= 400 ? "bad" : entry.status >= 300 ? "warn" : "ok";
          if (!collection) {
            return (
              <div key={entry.id} className="history-row stale" title={entry.error ?? entry.url}>
                <span className={`history-status status ${tone}`}>{entry.status ?? "—"}</span>
                <span className="request-name">{entry.name}</span>
                <small>{formatWhen(entry.at)}</small>
              </div>
            );
          }
          return (
            <button
              type="button"
              key={entry.id}
              className="history-row"
              title={entry.url}
              onClick={() => onSelect({ kind: "request", collectionId: collection.id, requestId: entry.requestId })}
            >
              <span className={`history-status status ${tone}`}>{entry.status ?? "—"}</span>
              <span className="request-name">{entry.name}</span>
              <small>{formatWhen(entry.at)}</small>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
