import assert from "node:assert/strict";
import test from "node:test";
import { projectContextForDefinition } from "@lcode/shared";
import { MessageHistoryImpl } from "../../agent/message-history.js";
import { prepareTurnProjectContext } from "./turn-project-context.js";
import { steerTurn } from "./steering-admission.js";

test("accepted scope selects the primary command cwd while preserving the runtime project anchor", async () => {
  const project = { id: "p", name: "Project", primaryFolderPath: "/web", sourceFolderPaths: ["/web", "/api"], primaryMemberId: "api", members: [
    { id: "web", path: "/web", role: "", label: "", description: "", enabled: true },
    { id: "api", path: "/api", role: "", label: "", description: "", enabled: true },
  ] };
  const accepted = projectContextForDefinition(project, { workspacePath: "/web" });
  project.primaryMemberId = "web";
  const messageHistory = new MessageHistoryImpl(); messageHistory.init("system");
  const runtime = { messageHistory, workingDirectory: "/web", workspaceRoot: "/web", setWorkingDirectory(cwd: string) { this.workingDirectory = cwd; }, fileSystemPort: { stat: async () => ({ kind: "directory" }) } };
  await prepareTurnProjectContext(runtime as never, { projectContext: accepted } as never, new AbortController().signal);
  assert.equal(runtime.workingDirectory, "/api");
  assert.equal(runtime.workspaceRoot, "/web");
  await prepareTurnProjectContext(runtime as never, { projectContext: projectContextForDefinition(project, { workspacePath: "/web" }) } as never, new AbortController().signal);
  assert.equal(runtime.workingDirectory, "/web");
});

test("native model context includes all frozen project members without any MCP", async () => {
  const messageHistory = new MessageHistoryImpl();
  messageHistory.init("system");
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      revision: 3,
      primaryFolderPath: "/web",
      sourceFolderPaths: ["/web", "/api"],
    },
    { workspacePath: "/web" },
  );
  const paths: string[] = [];
  const runtime = {
    messageHistory,
    setWorkingDirectory: (_cwd: string) => {},
    fileSystemPort: {
      stat: async ({ path }: { path: string }) => {
        paths.push(path);
        return { kind: "directory" };
      },
    },
  };
  await prepareTurnProjectContext(
    runtime as never,
    { projectContext } as never,
    new AbortController().signal,
  );
  assert.deepEqual(paths, ["/web", "/api"]);
  assert.match(JSON.stringify(messageHistory.borrowReadOnlyRuntimeEntries()), /\/api/);
  assert.match(
    JSON.stringify(messageHistory.borrowReadOnlyRuntimeEntries()),
    /"revision\\": 3|"revision":3/,
  );
  await prepareTurnProjectContext(
    runtime as never,
    { projectContext } as never,
    new AbortController().signal,
  );
  assert.equal(
    messageHistory
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.metadata?.source === "project_scope").length,
    1,
  );
  runtime.fileSystemPort.stat = async () => {
    throw new Error("Directory removed after admission");
  };
  await assert.rejects(
    prepareTurnProjectContext(
      runtime as never,
      { projectContext } as never,
      new AbortController().signal,
    ),
    /removed after admission/,
  );
});

test("guide retains the active project scope and queues changes for the next turn", async () => {
  const projectContext = projectContextForDefinition({ id: "p", name: "Project", revision: 1, primaryFolderPath: "/web", sourceFolderPaths: ["/web", "/api"] }, { workspacePath: "/web" });
  const messageHistory = new MessageHistoryImpl(); messageHistory.init("system");
  const runtime = { messageHistory, setWorkingDirectory: (_cwd: string) => {}, fileSystemPort: { stat: async () => ({ kind: "directory" }) }, sessionId: "chat", activeTurn: { turnId: "turn", steerable: true, traceContext: { traceId: "trace" }, pendingInputs: [] as Array<{ delivery?: string; intent?: { fallbackReasonCode?: string } }> }, appendEvent: async () => {}, createPendingInputId: () => "input" };
  await prepareTurnProjectContext(runtime as never, { projectContext } as never, new AbortController().signal);
  await steerTurn.call(runtime as never, { input: "same scope", delivery: "guide", intent: { projectContext } } as never);
  assert.equal(runtime.activeTurn.pendingInputs[0]?.delivery, "guide");
  await steerTurn.call(runtime as never, { input: "changed scope", delivery: "guide", intent: { projectContext: { ...projectContext, revision: 2 } } } as never);
  assert.equal(runtime.activeTurn.pendingInputs[1]?.delivery, "queue");
  assert.equal(runtime.activeTurn.pendingInputs[1]?.intent?.fallbackReasonCode, "guide.projectScopeChanged");
});
