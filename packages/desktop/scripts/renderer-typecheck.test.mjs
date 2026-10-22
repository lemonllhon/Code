import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../..");
const desktop = resolve(root, "packages/desktop");
function config(name) {
  return ts.getParsedCommandLineOfConfigFile(
    resolve(desktop, name),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
}

function referencedOutputDirectories(project, visited = new Set()) {
  const directories = [];
  for (const reference of project.projectReferences ?? []) {
    const path = ts.resolveProjectReferencePath(reference);
    if (visited.has(path)) continue;
    visited.add(path);
    const referenced = config(path);
    for (const directory of [referenced.options.outDir, referenced.options.declarationDir]) {
      if (directory) directories.push(`${resolve(directory)}${sep}`);
    }
    directories.push(...referencedOutputDirectories(referenced, visited));
  }
  return directories;
}

test("root checks Renderer, preload and Node tests without emitting runtime bundles", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const name of ["renderer", "renderer-test", "preload"]) {
    const path = `packages/desktop/tsconfig.${name}.json`;
    assert.ok(manifest.scripts.typecheck.split(/\s+/u).includes(path), path);
    const parsed = config(`tsconfig.${name}.json`);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.options.noEmit, true);
    assert.equal(parsed.options.noUncheckedIndexedAccess, true);
  }
  const renderer = config("tsconfig.renderer.json");
  const tests = config("tsconfig.renderer-test.json");
  assert.ok(renderer.options.types.includes("vite/client"));
  assert.ok(renderer.options.types.includes("@lcode/client/globals"));
  assert.ok(!renderer.options.types.includes("node"));
  assert.ok(tests.options.types.includes("node"));
  assert.ok(!renderer.fileNames.some((path) => /\.test\.tsx?$/u.test(path)));
  const testFiles = ts.sys
    .readDirectory(resolve(desktop, "src/renderer"), [".ts", ".tsx"])
    .filter((path) => /\.test\.tsx?$/u.test(path));
  assert.ok(testFiles.length >= 2);
  for (const path of testFiles) assert.ok(tests.fileNames.includes(path), path);
});

test("public preload signatures match platform results and keep Node outside Renderer without prebuilt outputs", async () => {
  const parsed = config("tsconfig.renderer.json");
  const fixture = resolve(desktop, "src/renderer/typecheck-fixture.ts");
  const source = `
    import type { BrowserGuestAttachResult, IPlatformService } from '@lcode/shared';
    import type { DesktopPreloadBridge } from '@lcode/client/globals';
    const bind: Promise<void> = window.lcode.bindRemoteWorkspaceSessionContext!({
      remoteSessionId: 'remote-session', workspacePath: '/workspace', workspaceIdentity: 'scope',
    });
    const attach: Promise<BrowserGuestAttachResult> = window.lcode.browserViewAttachGuest!({
      key: 'tab', webContentsId: 1,
    });
    const attachment: NonNullable<IPlatformService['createTempTextAttachment']> = window.lcode.createTempTextAttachment;
    const loadMcp: NonNullable<IPlatformService['loadMcpFromUserDirectory']> = window.lcode.loadMcpFromUserDirectory;
    const filePath: string | null = window.lcode.getPathForFile!({});
    const bridge: DesktopPreloadBridge = window.lcode;
    const device: Promise<string> = window.lcode.getDeviceId();
    const timer: number = window.setInterval(() => {}, 1000);
    const env: boolean = import.meta.env.DEV;
    import '@lcode/ui/styles.css';
    // @ts-expect-error guest 挂接不可误声明成 void。
    const wrongAttach: Promise<void> = window.lcode.browserViewAttachGuest!({key: 'tab', webContentsId: 1});
    // @ts-expect-error 远程绑定不可误声明成 guest 结果。
    const wrongBind: Promise<BrowserGuestAttachResult> = bind;
    // @ts-expect-error contextIsolation 页面不具有 Node process。
    process.cwd();
    // @ts-expect-error contextIsolation 页面不具有 Node require。
    require('node:fs');
  `;
  const host = ts.createCompilerHost(parsed.options);
  // createProgram 不构建引用工程；直接检查源码，才能在尚无声明产物时验证公共契约。
  host.useSourceOfProjectReferenceRedirect = () => true;
  // 屏蔽引用工程的输出，避免本地已有 dist 掩盖干净 CI 的 TS6305。
  const outputDirectories = referencedOutputDirectories(parsed);
  const isOutput = (path) =>
    outputDirectories.some((directory) => resolve(path).startsWith(directory));
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = (path) =>
    resolve(path) === fixture ? source : isOutput(path) ? undefined : read(path);
  host.fileExists = (path) => !isOutput(path) && exists(path);
  const program = ts.createProgram({
    rootNames: [fixture],
    options: { ...parsed.options, composite: false, incremental: false },
    projectReferences: parsed.projectReferences,
    host,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (path) => path,
      getNewLine: () => "\n",
    }),
  );
  assert.ok(program.getSourceFile(resolve(root, "packages/shared/src/index.ts")));
  const checker = program.getTypeChecker();
  const fixtureFile = program.getSourceFile(fixture);
  const declared = checker
    .getPropertiesOfType(
      checker.getTypeAtLocation(
        fixtureFile.statements
          .flatMap((statement) =>
            ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
          )
          .find((declaration) => declaration.name.getText(fixtureFile) === "bridge").name,
      ),
    )
    .map(({ name }) => name)
    .sort();
  const preloadPath = resolve(desktop, "src/preload/index.ts");
  const preload = ts.createSourceFile(
    preloadPath,
    await readFile(preloadPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let exposed;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(preload) === "contextBridge.exposeInMainWorld" &&
      node.arguments[0]?.text === "lcode"
    ) {
      const value = node.arguments[1];
      exposed = (ts.isSatisfiesExpression(value) ? value.expression : value).properties
        .map((property) => property.name.getText(preload))
        .sort();
    }
    ts.forEachChild(node, visit);
  }
  visit(preload);
  assert.deepEqual(
    declared,
    exposed,
    "Every exposed preload capability must have a public declaration",
  );
});
