import { createRequire } from "node:module";
import path from "node:path";

/**
 * Arma el loader de módulos locales para `omnium.require`. Solo lo crean los
 * hosts con Node (escritorio, servidor, CLI): este archivo nunca entra al
 * bundle del renderer. Devuelve `undefined` cuando no hay directorio (área en
 * memoria o nube), y ahí el script recibe el error claro de `omnium.require`.
 */
export function createModuleLoader(dir: string | null | undefined): ((specifier: string) => unknown) | undefined {
  if (!dir) return undefined;
  try {
    const requireFrom = createRequire(path.join(path.resolve(dir), "package.json"));
    return (specifier: string) => requireFrom(specifier);
  } catch {
    return undefined;
  }
}
