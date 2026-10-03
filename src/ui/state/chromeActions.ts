import type { Dispatch, SetStateAction } from "react";
import type { Workspace } from "../../core/types.ts";
import type { Command } from "../palette.tsx";
import type { Selection } from "./model.ts";

export type Modal = null | "help" | "curl" | "palette" | "snippet" | "cookies";

export type ChromeActions = ReturnType<typeof createChromeActions>;

/** Chrome de la interfaz: paleta de comandos, resize de paneles y atajos
 * globales que no pertenecen a otro dominio. */
export function createChromeActions(deps: {
  workspace: Workspace | null;
  commandKey: string;
  sideW: number;
  outW: number;
  setSideW: Dispatch<SetStateAction<number>>;
  setOutW: Dispatch<SetStateAction<number>>;
  setPane: (pane: "response" | "tests" | "load") => void;
  setModal: Dispatch<SetStateAction<Modal>>;
  choose: (selection: Selection) => void;
  send: (asTest?: boolean) => Promise<void>;
  beginImport: (kind: "area" | "postman") => void;
  refreshCookies: () => Promise<void>;
}) {
  const { workspace, commandKey, sideW, outW, setSideW, setOutW, setPane, setModal, choose, send, beginImport, refreshCookies } = deps;

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

  return { startResize, commands };
}
