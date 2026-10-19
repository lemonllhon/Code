import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import type { BrowserWindow, MessagePortMain, UtilityProcess } from "electron";
import { buildRemoteWorkspaceIdentity, HostMessageTypes, HostResponseTypes } from "@lcode/shared";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron")
      return {
        url: "data:text/javascript,export const BrowserWindow={getAllWindows(){return []}};export class MessageChannelMain{}",
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { createRemoteWorkspaceSessionManager } = await import("./desktopRemoteSessions.js");

for (const lateSuccess of [false, true]) {
  test(`远端在首次同步${lateSuccess ? "刚完成" : "等待中"}退出 137，不发布迟到 attachment`, async () => {
    const messages: Record<string, unknown>[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {}, postMessage() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
      createMessageChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
    });
    const target = { kind: "ssh" as const, host: "fixture.example.invalid", username: "fixture" };
    let settled: string | undefined;
    const result = manager.createRemoteWorkspaceSession(win, target, "request").then(
      (id) => {
        settled = id;
        return id;
      },
      (error: Error) => {
        settled = error.message;
        return error.message;
      },
    );
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnected,
      requestId: "request",
      descriptor: {
        remoteSessionId: "session",
        target,
        workspacePath: "/fixture",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/fixture", target),
        generation: 1,
      },
    });
    const provision = messages.find(
      (message) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )!;
    const success = () =>
      child.emit("message", {
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: provision.requestId,
        environmentKey: provision.environmentKey,
        status: "applied",
      });
    if (lateSuccess) success();
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: "session",
      reason: "connection-closed",
      exitCode: 137,
      signal: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeLate = settled;
    if (!lateSuccess) success();
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.disposeRemoteWorkspaceSessionsForWindow(1);
    await result;
    assert.ok(beforeLate);
    assert.match(beforeLate, lateSuccess ? /关闭/ : /137/);
    assert.equal(
      messages.some((message) => message.type === HostMessageTypes.AttachServicePort),
      false,
    );
  });
}

for (const structured of [true, false]) {
  test(`首次 Provider 失败展示脱敏原因，${structured ? "保留固定候选状态" : "兼容旧远端"}`, async () => {
    const messages: Record<string, unknown>[] = [];
    const logs: unknown[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {}, postMessage() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: {
        info: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
    });
    const target = {
      kind: "ssh" as const,
      host: "private.example.invalid",
      username: "fixture-user",
    };
    const connecting = manager.createRemoteWorkspaceSession(win, target, "request");
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnected,
      requestId: "request",
      descriptor: {
        remoteSessionId: "session",
        target,
        workspacePath: "/private/project",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/private/project", target),
        generation: 1,
      },
    });
    const provision = messages.find(
      (message) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )!;
    assert.ok(provision);
    const rejection = assert.rejects(connecting, (error: Error) => {
      assert.match(
        error.message,
        structured
          ? /初始化远端 Provider.*内置 Provider 配置不可用.*随包配置缺失/
          : /远端未提供结构化原因/,
      );
      assert.ok(!error.message.includes("fixture-secret"));
      return true;
    });
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: provision.requestId,
      environmentKey: provision.environmentKey,
      status: "failed",
      error: "fixture-secret https://private.example.invalid /private/project",
      ...(structured
        ? {
            failure: {
              stage: "remote-runtime",
              code: "builtin-unavailable",
              availability: { bundled: "missing", active: "missing" },
            },
          }
        : {}),
    });
    await rejection;
    const diagnostic = logs.filter((entry) =>
      JSON.stringify(entry).includes("[provider-provisioning]"),
    );
    assert.ok(diagnostic.length > 0);
    for (const part of [
      "fixture-secret",
      "private.example.invalid",
      "/private/project",
      "fixture-user",
    ])
      assert.ok(!JSON.stringify(diagnostic).includes(part));
    assert.equal(
      messages.some((message) => message.type === HostMessageTypes.AttachServicePort),
      false,
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(1);
  });
}

for (const action of ["cancel", "window-close", "shutdown"] as const) {
  test(`WSL identity resolution: ${action} fences a late result before Host dispatch`, async () => {
    let finish!: (value: { kind: "wsl"; distro: string; user: string }) => void;
    let signal: AbortSignal | undefined;
    const identity = new Promise<{ kind: "wsl"; distro: string; user: string }>((resolve) => {
      finish = resolve;
    });
    const messages: { type: string }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: { type: string }) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
      resolveWslTarget: (_target, abortSignal?: AbortSignal) => {
        signal = abortSignal;
        return identity;
      },
    });
    const connecting = manager.createRemoteWorkspaceSession(win, { kind: "wsl" }, "request");
    const rejected = assert.rejects(connecting, /取消|关闭|退出/);
    if (action === "cancel")
      manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    if (action === "window-close") manager.disposeRemoteWorkspaceSessionsForWindow(1);
    if (action === "shutdown") await manager.disposeAllAndWaitForAppShutdown("test");
    // 先放行旧 resolver，失败实现也能结束，不靠 timeout 判断取消是否生效。
    finish({ kind: "wsl", distro: "TestDistro", user: "tester" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const dispatched = messages.some(
      (message) => message.type === HostMessageTypes.ConnectRemoteWorkspace,
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(1);
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(dispatched, false);
  });
}

for (const connected of [false, true]) {
  test(`cancellation ${connected ? "during provider initialization" : "after dispatch"} disposes late Host sessions`, async () => {
    const messages: { type: string; requestId?: string; remoteSessionId?: string }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: (typeof messages)[number]) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
    });
    const result = manager
      .createRemoteWorkspaceSession(win, { kind: "docker", container: "test-container" }, "request")
      .then(
        () => "success",
        (error: Error) => error.message,
      );
    const complete = () =>
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceConnected,
        requestId: "request",
        descriptor: {
          remoteSessionId: "session",
          target: { kind: "docker", container: "test-container" },
          generation: 1,
        },
      });
    if (connected) complete();
    manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    if (!connected) complete();
    try {
      assert.ok(
        messages.some(
          (message) =>
            message.type === HostMessageTypes.DisposeRemoteWorkspaceSession &&
            message.remoteSessionId === "session",
        ),
      );
      assert.match(await result, /取消/);
    } finally {
      // 放行 provider owner 的退出；迟到的初始化回调不得再创建 attachment。
      child.emit("exit", 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        messages.filter((message) => message.type === HostMessageTypes.AttachServicePort).length,
        0,
      );
    }
  });
}

for (const cancel of [false, true]) {
  test(`renderer readiness ${cancel ? "cannot revive a cancelled connection" : "publishes the initialized remote session"}`, async () => {
    const messages: {
      type: string;
      requestId?: string;
      environmentKey?: string;
      attachmentId?: string;
      clientMode?: string;
      scope?: unknown;
    }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: (typeof messages)[number]) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {}, postMessage() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
      createMessageChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
    });
    const target = { kind: "ssh" as const, host: "::1", username: "tester" };
    const workspaceIdentity = buildRemoteWorkspaceIdentity("/project", target);
    const result = manager.createRemoteWorkspaceSession(win, target, "request").then(
      (id) => id,
      (error: Error) => error.message,
    );
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnected,
      requestId: "request",
      descriptor: {
        remoteSessionId: "session",
        target,
        workspacePath: "/project",
        workspaceIdentity,
        generation: 1,
      },
    });
    const provision = messages.find(
      (message) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )!;
    assert.ok(provision);
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: provision.requestId,
      environmentKey: provision.environmentKey,
      status: "applied",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const attachment = messages.find(
      (message) => message.type === HostMessageTypes.AttachServicePort,
    )!;
    assert.ok(attachment);
    assert.equal(attachment.clientMode, "desktop-continuous");
    assert.deepEqual(attachment.scope, {
      kind: "remote",
      remoteSessionId: "session",
      workspacePath: "/project",
      workspaceIdentity,
    });
    if (cancel) manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    manager.confirmRendererAttachmentReady(1, {
      sessionId: "session",
      attachmentId: attachment.attachmentId!,
    });
    if (cancel) assert.match(await result, /取消/);
    else assert.equal(await result, "session");
    if (!cancel) manager.disposeRemoteWorkspaceSession("session");
    child.emit("exit", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      messages.filter((message) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession)
        .length,
      1,
    );
  });
}
