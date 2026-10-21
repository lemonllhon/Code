import type { IGitService } from "@lcode/services";
import type { GitNetworkOperation, GitIntegrationPreview } from "@lcode/shared";
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
const head = "a".repeat(40),
  target = "b".repeat(40),
  root = "/fixture/repo",
  now = "2026-10-20T01:00:00Z";
export function integrationService(host: string, external = false, unknown = false) {
  let stamp = 1,
    owner: GitNetworkOperation | null = null,
    native: "merge" | "rebase" | null = external ? "merge" : null,
    conflict = false,
    round = 0,
    result = "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n";
  const receipts = new Map<string, GitNetworkOperation>();
  const revision = () => String(stamp).padStart(64, "0");
  const call = (method: string, params: any) => calls.push({ host, method, params });
  const entry = () => ({
    path: "src/main.ts",
    kind: "both-modified",
    stages: [1, 2, 3].map((stage) => ({ stage, oid: String(stage).repeat(40), mode: "100644" })),
  });
  const snapshot = () => ({
    root,
    revision: revision(),
    head,
    branch: native === "rebase" ? null : "main",
    operation: owner,
    blocked: false,
    nativeMode: native,
    canContinue: Boolean(owner && native && !conflict),
    canAbort: Boolean(owner && native),
    needsNativeConfirmation: Boolean(owner?.unsettled),
    conflicts: conflict ? ["src/main.ts"] : [],
    changedFiles: native ? ["src/main.ts"] : [],
    progress: native === "rebase" ? `${round + 1} / 2` : null,
  });
  const version = (text: string) => ({
    kind: "text",
    oid: null,
    mode: "100644",
    size: text.length,
    text,
    eol: "lf",
  });
  const service = {
    getNetworkSnapshot: async (params: any) => {
      call("network", params);
      return {
        revision: revision(),
        branch: "main",
        head,
        upstream: null,
        ahead: 0,
        behind: 0,
        remotes: [],
        branches: [
          { name: "main", head, upstream: null },
          { name: "topic", head: target, upstream: null },
        ],
        remoteBranches: [],
      };
    },
    getIntegrationSnapshot: async (params: any) => {
      call("snapshot", params);
      return snapshot();
    },
    previewIntegration: async (params: any) => {
      call("preview", params);
      const preview = {
        root,
        revision: revision(),
        head,
        branch: "main",
        target,
        mode: params.mode,
        targetRef: params.targetRef,
        commitCount: 2,
        ...(params.targets ? { targets: params.targets } : {}),
        ...(params.mainline ? { mainline: params.mainline } : {}),
      };
      await wait();
      return preview;
    },
    getNetworkOperation: async (params: any) => {
      call("receipt", params);
      return params.requestId === owner?.requestId
        ? owner
        : (receipts.get(params.requestId) ?? null);
    },
    getConflictSnapshot: async (params: any) => {
      call("conflictSnapshot", params);
      return {
        root,
        revision: revision(),
        operation: native ?? "index",
        sourceRequestId: owner?.requestId ?? null,
        blocked: false,
        nativeCheck: false,
        files: conflict ? [entry()] : [],
      };
    },
    getConflictFile: async (params: any) => {
      call("file", params);
      return {
        path: params.path,
        revision: revision(),
        entry: entry(),
        base: version("base\n"),
        ours: version("ours\n"),
        theirs: version("theirs\n"),
        result: version(result),
        editable: true,
        canMark: !result.includes("<<<<<<<"),
        hasMarkers: result.includes("<<<<<<<"),
      };
    },
    previewGitOperationCompletion: async (params: any) => ({
      sourceRequestId: params.requestId,
      targetPath: root,
      revision: revision(),
      conflicts: conflict ? ["src/main.ts"] : [],
      canComplete: !native && !conflict,
      needsNativeConfirmation: unknown,
    }),
    ...Object.fromEntries(
      [
        "startIntegration",
        "continueIntegration",
        "abortIntegration",
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
              method === "startIntegration"
                ? params.preview.mode
                : method === "continueIntegration"
                  ? "integration-continue"
                  : method === "abortIntegration"
                    ? "integration-abort"
                    : method === "saveConflictResult"
                      ? "conflict-save"
                      : method === "markConflictResolved"
                        ? "conflict-mark"
                        : "reconcile",
            status: "success",
            targetPath: root,
            startedAt: now,
          };
          if (params.expectedRevision && params.expectedRevision !== revision()) {
            receipt.status = "failed";
            receipt.code = "stale-preview";
          } else {
            if (method === "startIntegration") {
              const preview = params.preview as GitIntegrationPreview;
              native = preview.mode;
              conflict = true;
              owner = {
                ...receipt,
                integration: { mode: native, branch: "main", head, target },
                status: unknown ? "unknown" : "conflict",
                unsettled: unknown,
              };
              receipt.status = owner.status;
            }
            if (method === "continueIntegration") {
              round++;
              conflict = native === "rebase" && round < 2;
              receipt.status = conflict ? "conflict" : "success";
              if (!conflict) {
                native = null;
                owner = null;
              }
            }
            if (method === "abortIntegration" || method === "completeGitOperation") {
              native = null;
              owner = null;
              conflict = false;
              receipt.resolved = true;
            }
            if (method === "saveConflictResult") result = params.text;
            if (method === "markConflictResolved") conflict = false;
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
    },
  };
}
