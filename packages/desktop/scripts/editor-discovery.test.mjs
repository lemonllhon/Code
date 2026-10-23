import assert from "node:assert/strict";
import test from "node:test";
import { loadEditorDiscovery, nextTurn } from "./editor-discovery-test-fixture.mjs";
import { editorDiscoveryDefines, editorDiscoveryStubs } from "./editor-discovery-test-fixture.mjs";
import { loadSource } from "./main-runtime-test-fixture.mjs";

test("importing editor definitions performs no directory scans or synchronous IO", async (t) => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const module = await loadEditorDiscovery(t, platform);
    const state = module.testElectron.state;
    assert.deepEqual(state.syncCalls, []);
    assert.deepEqual(state.directoryReads, []);
    assert.deepEqual(state.commands, []);
  }
});

test("cold concurrent requests share one flight through slow discovery and icon loading", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.holdCommands = true;
  const first = module.getInstalledEditors();
  const second = module.getInstalledEditors();
  assert.equal(first, second);
  await nextTurn();
  assert.equal(state.commands.length, 3);
  assert.deepEqual(state.syncCalls, []);
  assert.equal(state.pending.length, 3);
  state.holdIcons = true;
  state.holdCommands = false;
  for (const release of state.pending.splice(0)) release();
  await nextTurn();
  assert.equal(state.icons.length, 1);
  assert.equal(state.pendingIcons.length, 1);
  for (const release of state.pendingIcons.splice(0)) release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(
    a.map((editor) => editor.id),
    ["explorer"],
  );
  const probes = state.commands.length;
  assert.equal(await module.getInstalledEditors(), a);
  assert.equal(state.commands.length, probes);
});

test("a rejected shared scan can retry and successful empty results remain cached", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.failIcon = true;
  const results = await Promise.allSettled([
    module.getInstalledEditors(),
    module.getInstalledEditors(),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(state.commands.length, 3);
  state.failIcon = false;
  assert.equal((await module.getInstalledEditors()).length, 1);
  assert.equal(state.commands.length, 6);

  const empty = await loadEditorDiscovery(t, "linux");
  assert.deepEqual(await empty.getInstalledEditors(), []);
  assert.deepEqual(await empty.getInstalledEditors(), []);
  assert.equal(empty.testElectron.state.logs.length, 1);
});

test("fixed installation paths avoid PATH probes and retain their precedence", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.files.add("C:/fixture/Code.exe");
  const selected = await module.resolveEditorDefAppPath({
    id: "vscode",
    name: "VS Code",
    appPath: "C:/fixture/Code.exe",
    command: "code",
    windowsCommandAppNames: ["Code.exe"],
  });
  assert.equal(selected, "C:/fixture/Code.exe");
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.syncCalls, []);
});

test("Windows PATH shim discovery finds the executable and missing commands stay optional", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.files.add("C:/custom/VS Code/bin/code.cmd");
  state.files.add("C:/custom/VS Code/Code.exe");
  state.contents["command:code"] = "C:/custom/VS Code/bin/code.cmd\r\n";
  const editors = await module.getInstalledEditors();
  assert.deepEqual(
    editors.map((editor) => editor.id),
    ["explorer", "vscode"],
  );
  assert.ok(
    state.icons.some((path) => path.replaceAll("\\", "/") === "C:/custom/VS Code/Code.exe"),
  );
  for (const { file, options } of state.commands) {
    assert.equal(file, "where.exe");
    assert.equal(options.timeout, 1000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
  }
});

test("a timed out optional PATH probe does not discard installed editors or retry on warm reads", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.commandErrors.code = { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" };
  const editors = await module.getInstalledEditors();
  assert.deepEqual(
    editors.map((editor) => editor.id),
    ["explorer"],
  );
  assert.equal(await module.getInstalledEditors(), editors);
  assert.equal(state.commands.length, 3);
  assert.deepEqual(state.syncCalls, []);
});

test("JetBrains roots are read once per definition batch with original version precedence", async (t) => {
  const module = await loadEditorDiscovery(t);
  const state = module.testElectron.state;
  state.directories["C:/fixture/ProgramFiles/JetBrains"] = [
    { name: "IntelliJ IDEA 2025", directory: true },
    { name: "IntelliJ IDEA 2026", directory: true },
    { name: "IntelliJ IDEA fake", directory: false },
  ];
  const definitions = await module.getEditorDefsForCurrentPlatform();
  const idea = definitions.find((def) => def.id === "idea");
  assert.ok(idea.appPath.replaceAll("\\", "/").endsWith("IntelliJ IDEA 2026/bin/idea64.exe"));
  assert.equal(new Set(state.directoryReads).size, state.directoryReads.length);
  assert.deepEqual(state.syncCalls, []);
});

test("macOS reads plist and PNG ICNS asynchronously without invoking sips", async (t) => {
  const module = await loadEditorDiscovery(t, "darwin");
  const state = module.testElectron.state;
  state.files.add("/fixture/Editor.app/Contents/Resources/app.icns");
  state.contents["/fixture/Editor.app/Contents/Resources/app.icns"] = "icns";
  const icon = await module.getAppIconDataUrl("fixture", "/fixture/Editor.app");
  assert.ok(icon.startsWith("data:image/png;base64,"));
  assert.deepEqual(
    state.commands.map((call) => call.file),
    ["plutil"],
  );
  assert.deepEqual(state.syncCalls, []);
});

test("macOS conversion and temporary directory failures retain native icon fallback", async (t) => {
  for (const failure of ["none", "mkdir", "sips"]) {
    const module = await loadEditorDiscovery(t, "darwin");
    const state = module.testElectron.state;
    state.files.add("/fixture/Editor.app/Contents/Resources/app.icns");
    state.contents["/fixture/Editor.app/Contents/Resources/app.icns"] = "icns";
    state.invalidIcns = true;
    state.failMkdir = failure === "mkdir";
    state.failSips = failure === "sips";
    const icon = await module.getAppIconDataUrl("fixture", "/fixture/Editor.app");
    assert.ok(icon.startsWith("data:image/png;base64,"));
    assert.deepEqual(state.removed, state.created);
    assert.equal(state.icons.length, failure === "none" ? 0 : 1);
    assert.deepEqual(state.syncCalls, []);
  }
});

test("opening a local file or directory retains the file manager action", async (t) => {
  const module = await loadSource(t, "src/main/openInEditor.ts", editorDiscoveryStubs(), {
    define: editorDiscoveryDefines(),
  });
  const state = module.testElectron.state;
  state.files.add("C:/fixture/file.txt");
  state.files.add("C:/fixture/folder");
  assert.deepEqual(await module.openInEditor("explorer", "C:/fixture/file.txt"), { success: true });
  assert.deepEqual(await module.openInEditor("explorer", "C:/fixture/folder"), { success: true });
  assert.deepEqual(state.revealed, ["C:/fixture/file.txt"]);
  assert.deepEqual(state.opened, ["C:/fixture/folder"]);
  assert.deepEqual(state.syncCalls, []);
});

test("VS Code remote opens preserve SSH and WSL URIs without local path probes", async (t) => {
  const module = await loadSource(t, "src/main/openInEditor.ts", editorDiscoveryStubs(), {
    define: editorDiscoveryDefines(),
  });
  const state = module.testElectron.state;
  state.files.add("C:/fixture/Local/Programs/Microsoft VS Code/Code.exe");
  assert.deepEqual(
    await module.openInEditor("vscode", "/remote/file.ts", {
      pathKind: "file",
      remoteTarget: { kind: "ssh", host: "fixture.invalid", username: "tester", port: 2222 },
    }),
    { success: true },
  );
  assert.deepEqual(state.commands.at(-1).args, [
    "--file-uri",
    "vscode-remote://ssh-remote+tester%40fixture.invalid%3A2222/remote/file.ts",
  ]);
  assert.deepEqual(
    await module.openInEditor("vscode", "/remote/folder", {
      pathKind: "directory",
      remoteTarget: { kind: "wsl", distro: "Fixture" },
    }),
    { success: true },
  );
  assert.deepEqual(state.commands.at(-1).args, [
    "--folder-uri",
    "vscode-remote://wsl+Fixture/remote/folder",
  ]);
  assert.deepEqual(state.statPaths, []);
  assert.deepEqual(state.syncCalls, []);
});
