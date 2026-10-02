import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { filesToWorkspace, workspaceToFiles } from "../core/files.ts";
import { sampleWorkspace } from "../core/sample.ts";
import type { Workspace } from "../core/types.ts";

const MANAGED = /^(omnium\.json|history\.json|environments\/.+|collections\/.+)$/;

export async function ensureWorkspace(dir: string): Promise<Workspace> {
  await mkdir(dir, { recursive: true });
  try {
    await readFile(path.join(dir, "omnium.json"), "utf8");
  } catch {
    const workspace = sampleWorkspace();
    await saveToDir(dir, workspace);
    return workspace;
  }
  return loadFromDir(dir);
}

export async function loadFromDir(dir: string): Promise<Workspace> {
  const files: Record<string, string> = {};
  for (const relative of await listFiles(dir)) {
    if (!MANAGED.test(relative)) continue;
    files[relative] = await readFile(path.join(dir, relative), "utf8");
  }
  if (!files["omnium.json"]) throw new Error("Esta carpeta no tiene un área de Omnium");
  return filesToWorkspace(files);
}

export async function saveToDir(dir: string, workspace: Workspace): Promise<void> {
  const files = workspaceToFiles(workspace);
  await mkdir(dir, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  for (const relative of await listFiles(dir)) {
    if (!MANAGED.test(relative) || files[relative]) continue;
    await rm(path.join(dir, relative), { force: true });
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else out.push(next);
    }
  }
  await walk("");
  return out;
}
