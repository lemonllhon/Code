import type { IGitService } from "@lcode/services";
import type { GitConflictFile, GitNetworkOperation } from "@lcode/shared";
export const calls: { host: string; method: string; params: any }[] = [];
let held = false,
  lost = false;
const waiters: (() => void)[] = [];
export const controls = {
  hold: () => {
    held = true;
  },
  release: () => {
    held = false;
    waiters.splice(0).forEach((resolve) => resolve());
  },
  lostAck: () => {
    lost = true;
  },
};
const wait = async () => {
  if (held) await new Promise<void>((resolve) => waiters.push(resolve));
};
export function conflictService(host: string, external = false, binary = false, mixed = false) {
  let stamp = 1,
    source: string | null = external ? null : "source",
    resolved = false;
  const root = "/fixture/repo",
    result = new Map([
      [
        "src/main.ts",
        mixed
          ? "<<<<<<< ours\r\nours\n=======\r\ntheirs\n>>>>>>> theirs\r\n"
          : "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
      ],
      ["src/secondary.ts", "second\n"],
    ]);
  const revision = () => String(stamp).padStart(64, "0"),
    receipts = new Map<string, GitNetworkOperation>();
  const stages = [1, 2, 3].map((stage) => ({
    stage,
    oid: String(stage).repeat(40),
    mode: "100644",
  }));
  const entries = () =>
    [...result.keys()].map((path) => ({ path, stages, kind: "both-modified" as const }));
  const owner = (): GitNetworkOperation | null =>
    source
      ? {
          requestId: source,
          kind: external ? "conflict-resolution" : "stash-apply",
          status: "conflict",
          startedAt: "2026-10-20T01:00:00.000Z",
          targetPath: root,
          conflicts: entries().map(({ path, stages }) => ({ path, stages })),
          resolved,
        }
      : null;
  const call = (method: string, params: unknown) => calls.push({ host, method, params });
  const version = (text: string, index: number): GitConflictFile["result"] => ({
    kind: binary ? "binary" : "text",
    text: binary ? null : text,
    size: text.length,
    mode: "100644",
    oid: index ? String(index).repeat(40) : null,
    eol: text.includes("\r\n")
      ? text.replaceAll("\r\n", "").includes("\n")
        ? "mixed"
        : "crlf"
      : "lf",
  });
  const service = {
    getConflictSnapshot: async (params: unknown) => {
      call("snapshot", params);
      return {
        root,
        revision: revision(),
        operation: external ? "merge" : "stash",
        sourceRequestId: resolved ? null : source,
        blocked: false,
        nativeCheck: false,
        files: entries(),
      };
    },
    getConflictFile: async (params: { path: string }) => {
      call("file", params);
      await wait();
      const text = result.get(params.path);
      if (text === undefined) throw new Error("missing-conflict");
      const entry = entries().find((entry) => entry.path === params.path)!;
      return {
        path: params.path,
        revision: revision(),
        entry,
        base: version("base\n", 1),
        ours: version("ours\n", 2),
        theirs: version("theirs\n", 3),
        result:
          text === "[deleted]"
            ? { ...version("", 0), kind: "absent", text: null }
            : version(text, 0),
        editable: !binary,
        canMark: binary || !text.includes("<<<<<<<"),
        hasMarkers: !binary && text.includes("<<<<<<<"),
      };
    },
    getNetworkOperation: async (params: { requestId: string }) => {
      call("receipt", params);
      return params.requestId === source ? owner() : (receipts.get(params.requestId) ?? null);
    },
    getStashSnapshot: async () => ({
      revision: revision(),
      entries: [],
      blocked: true,
      operation: owner(),
    }),
    previewGitOperationCompletion: async (params: { requestId: string }) => ({
      sourceRequestId: params.requestId,
      targetPath: root,
      revision: revision(),
      conflicts: [...result.keys()],
      canComplete: result.size === 0,
      needsNativeConfirmation: false,
    }),
    ...Object.fromEntries(
      [
        "beginConflictResolution",
        "saveConflictResult",
        "markConflictResolved",
        "completeGitOperation",
      ].map((method) => [
        method,
        async (params: any) => {
          call(method, params);
          await wait();
          const receipt: GitNetworkOperation = {
            requestId: params.requestId,
            kind:
              method === "beginConflictResolution"
                ? "conflict-resolution"
                : method === "saveConflictResult"
                  ? "conflict-save"
                  : method === "markConflictResolved"
                    ? "conflict-mark"
                    : "reconcile",
            status: "success",
            targetPath: root,
            ...(params.path ? { filePath: params.path } : {}),
            startedAt: "2026-10-20T01:00:00.000Z",
          };
          if (params.expectedRevision !== revision()) {
            receipt.status = "failed";
            receipt.code = "stale-conflict";
          } else {
            if (method === "beginConflictResolution") {
              source = params.requestId;
              receipt.status = "conflict";
            }
            if (method === "saveConflictResult")
              result.set(params.path, params.action === "delete" ? "[deleted]" : params.text);
            if (method === "markConflictResolved") result.delete(params.path);
            if (method === "completeGitOperation") resolved = true;
            stamp++;
          }
          receipts.set(params.requestId, receipt);
          if (lost) {
            lost = false;
            throw new Error("lost-ack");
          }
          return receipt;
        },
      ]),
    ),
  } as unknown as IGitService;
  return {
    service,
    externalChange: () => {
      stamp++;
      result.set("src/main.ts", "external\n");
    },
  };
}
