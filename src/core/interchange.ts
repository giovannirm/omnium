import { exportBru, importBru } from "./bruno.ts";
import { exportInsomnia, importInsomnia } from "./insomnia.ts";
import { importHoppscotch } from "./hoppscotch.ts";
import { importJmeter } from "./jmeter.ts";
import { exportPostman, importPostman } from "./postman.ts";
import { importThunder } from "./thunder.ts";
import type { Collection } from "./types.ts";

/** Formatos de colección que Omnium puede importar. */
export type CollectionFormat = "postman" | "insomnia" | "bruno" | "jmeter" | "hoppscotch" | "thunder";

/** Resultado de detectar un archivo: colección intercambiable, área Omnium o nada. */
export type DetectedFormat = CollectionFormat | "omnium-area" | "unknown";

export type ImportResult = { collection: Collection; warnings: string[] };

export const FORMATS: Record<CollectionFormat, { label: string; extensions: string[] }> = {
  postman: { label: "Postman", extensions: [".json"] },
  insomnia: { label: "Insomnia", extensions: [".json", ".yaml", ".yml"] },
  bruno: { label: "Bruno", extensions: [".bru"] },
  jmeter: { label: "JMeter", extensions: [".jmx"] },
  hoppscotch: { label: "Hoppscotch", extensions: [".json"] },
  thunder: { label: "Thunder Client", extensions: [".json"] },
};

/** Extensión en minúsculas (con punto) o cadena vacía. */
export function extensionOf(fileName?: string): string {
  const match = /\.[a-z0-9]+$/i.exec(fileName ?? "");
  return match ? match[0].toLowerCase() : "";
}

/**
 * Detecta el formato por contenido primero y por extensión como respaldo.
 * El contenido manda: un `.json` que en realidad es Postman se lee como Postman.
 */
export function detectFormat(text: string, fileName?: string): DetectedFormat {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = tryParse(text);
    if (json !== undefined) return sniffJson(json);
  }
  if (/<jmeterTestPlan[\s>]/.test(text) || extensionOf(fileName) === ".jmx") return "jmeter";
  if (isBruno(text, fileName)) return "bruno";
  if (isInsomniaYaml(text, fileName)) return "insomnia";
  return "unknown";
}

/** Importa una colección en cualquier formato soportado; lanza errores en castellano. */
export function importCollection(text: string, fileName?: string): ImportResult {
  const format = detectFormat(text, fileName);
  if (format === "unknown") throw new Error("No se reconoce el formato de la colección");
  if (format === "omnium-area") {
    throw new Error("Es un área de Omnium: se importa como área de trabajo, no como colección");
  }
  if (format === "postman") {
    const json = tryParse(text);
    if (json === undefined) throw new Error("El archivo no es JSON válido");
    return importPostman(json);
  }
  if (format === "insomnia") return importInsomnia(text);
  if (format === "bruno") return importBru(text);
  if (format === "jmeter") return importJmeter(text);
  const json = tryParse(text);
  if (json === undefined) throw new Error("El archivo no es JSON válido");
  return format === "hoppscotch" ? importHoppscotch(json) : importThunder(json);
}

/** Formatos de exportación de colección. */
export type ExportFormat = "postman" | "insomnia" | "bruno";

/** Un archivo a descargar: `content` completo y `name` con extensión. */
export type ExportFile = { name: string; content: string };

/**
 * Devuelve los archivos a descargar para exportar `collection`.
 * Bruno genera un `.bru` por petición (un export por archivo, por diseño).
 */
export function exportCollectionAs(format: ExportFormat, collection: Collection): ExportFile[] {
  if (format === "postman") {
    return [
      {
        name: `${fileSlug(collection.name)}.postman.json`,
        content: `${JSON.stringify(exportPostman(collection), null, 2)}\n`,
      },
    ];
  }
  if (format === "insomnia") {
    return [
      {
        name: `${fileSlug(collection.name)}.insomnia.json`,
        content: `${JSON.stringify(exportInsomnia(collection), null, 2)}\n`,
      },
    ];
  }
  return collection.requests.map((request) => ({
    name: `${fileSlug(collection.name)}-${fileSlug(request.name)}.bru`,
    content: exportBru(request),
  }));
}

/** Nombre de archivo seguro: sin acentos, sin separadores de ruta, en minúsculas. */
export function fileSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "coleccion";
}

function sniffJson(json: unknown): DetectedFormat {
  if (Array.isArray(json)) return sniffArray(json);
  const record = json as Record<string, unknown>;
  if (typeof record.__export_format === "number") return "insomnia";
  // v5 serializado como JSON: el discriminador es `type: *.insomnia.rest/5.0`.
  if (typeof record.type === "string" && record.type.includes("insomnia.rest")) return "insomnia";
  if (record._type === "request-import") return "thunder";
  if (typeof record.client === "string" && record.client === "Thunder Client") return "thunder";
  if (record.info && record.item) return "postman";
  if (record.collections && record.version === 1) return "omnium-area";
  // HoppCollection: {name, folders[], requests[]} con v opcional.
  if (typeof record.name === "string" && Array.isArray(record.folders) && Array.isArray(record.requests)) return "hoppscotch";
  if (record.items !== undefined && (record.v === 1 || record.v === 2)) return "hoppscotch";
  return "unknown";
}

function sniffArray(json: unknown[]): DetectedFormat {
  const first = json[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const row = first as Record<string, unknown>;
    if (row._type === "request-import") return "thunder";
    if (typeof row.method === "string" && typeof row.url === "string" && ("serverId" in row || "folderId" in row)) {
      return "thunder";
    }
  }
  return "unknown";
}

function isBruno(text: string, fileName?: string): boolean {
  if (extensionOf(fileName) === ".bru") return true;
  return /^meta \{/m.test(text) && (/^http \{/m.test(text) || /^folder \{/m.test(text));
}

function isInsomniaYaml(text: string, fileName?: string): boolean {
  if (/^\s*type: .*insomnia/m.test(text)) return true;
  if (/^\s*__export_format:/m.test(text)) return true;
  const ext = extensionOf(fileName);
  if ((ext === ".yaml" || ext === ".yml") && /insomnia/i.test(text)) return true;
  return false;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
