import assert from "node:assert/strict";
import { test } from "node:test";
import { filesToWorkspace, workspaceToFiles } from "./files.ts";
import { sampleWorkspace } from "./sample.ts";

test("los scripts pre/post sobreviven el viaje por archivos", () => {
  const workspace = sampleWorkspace();
  const collection = workspace.collections[0]!;
  collection.preScript = "omnium.log('colección pre');";
  collection.postScript = "omnium.test('fin', () => omnium.expect(1).toBe(1));";
  workspace.environments[0]!.preScript = "omnium.env.set('base', 'nueva');";
  collection.requests[0]!.preScript = "omnium.variables.set('v', '1');";
  collection.requests[1]!.postScript = "omnium.log('post');";

  const reloaded = filesToWorkspace(workspaceToFiles(workspace));
  const reloadedCollection = reloaded.collections[0]!;
  assert.equal(reloadedCollection.preScript, "omnium.log('colección pre');");
  assert.equal(reloadedCollection.postScript, "omnium.test('fin', () => omnium.expect(1).toBe(1));");
  assert.equal(reloaded.environments[0]!.preScript, "omnium.env.set('base', 'nueva');");
  assert.equal(reloadedCollection.requests[0]!.preScript, "omnium.variables.set('v', '1');");
  assert.equal(reloadedCollection.requests[1]!.postScript, "omnium.log('post');");
});

test("un área sin scripts no inventa campos", () => {
  const reloaded = filesToWorkspace(workspaceToFiles(sampleWorkspace()));
  const collection = reloaded.collections[0]!;
  assert.equal(collection.preScript, undefined);
  assert.equal(collection.postScript, undefined);
  assert.equal(reloaded.environments[0]!.postScript, undefined);
  assert.equal(collection.requests[0]!.preScript, undefined);
});
