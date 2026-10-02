import type { Pair, Workspace } from "./types.ts";

/** Reemplazo que viaja en exportaciones y capturas. */
export const SECRET_MASK = "••••••";

/** Enmascara las filas marcadas como secretas; las demás quedan igual. */
export function maskPairs(pairs: Pair[]): Pair[] {
  return pairs.map((item) => (item.secret ? { ...item, value: SECRET_MASK } : item));
}

/** Copia del área lista para compartir: secretos enmascarados, el resto igual. */
export function maskWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    globals: maskPairs(workspace.globals),
    environments: workspace.environments.map((environment) => ({
      ...environment,
      variables: maskPairs(environment.variables),
    })),
    collections: workspace.collections.map((collection) => ({
      ...collection,
      variables: maskPairs(collection.variables),
    })),
  };
}

/** true si algún secreto habría que enmascarar en la exportación. */
export function hasSecrets(workspace: Workspace): boolean {
  return listPairs(workspace).some((item) => item.secret === true);
}

/** Claves secretas habilitadas: sirven para avisar en snippets y reportes. */
export function secretKeys(workspace: Workspace): string[] {
  return listPairs(workspace)
    .filter((item) => item.secret === true && item.enabled && item.key.trim())
    .map((item) => item.key.trim());
}

function listPairs(workspace: Workspace): Pair[] {
  return [
    ...workspace.globals,
    ...workspace.environments.flatMap((environment) => environment.variables),
    ...workspace.collections.flatMap((collection) => collection.variables),
  ];
}
