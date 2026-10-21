import type { IGitService } from "@lcode/services";
import type { GitNetworkOperation } from "@lcode/shared";
import {
  calls,
  controls as nativeControls,
  integrationService,
} from "./git-integration-service.js";
export { calls };
let held = false,
  lost = false;
const waiters: (() => void)[] = [];
export const controls = {
  hold: () => {
    held = true;
    nativeControls.hold();
  },
  release: () => {
    held = false;
    nativeControls.release();
    waiters.splice(0).forEach((resolve) => resolve());
  },
  lostAck: () => {
    lost = true;
  },
};
const wait = async () => {
  if (held) await new Promise<void>((resolve) => waiters.push(resolve));
};
const root = "/fixture/repo",
  head = "a".repeat(40),
  selected = "b".repeat(40),
  extra = "c".repeat(40);
export function historyService(
  host: string,
  merge = false,
  binary = false,
  many: boolean | number = false,
  context = false,
) {
  const base = integrationService(host),
    receipts = new Map<string, GitNetworkOperation>(),
    tags = new Map<string, any>();
  let stamp = 1;
  const revision = () => String(stamp).padStart(64, "0"),
    call = (method: string, params: any) => calls.push({ host, method, params });
  const commit = (hash: string) => ({
    hash,
    // 根提交不能把自身当 parent，否则图布局无法结束沿祖先的遍历。
    parents: hash === extra || hash === head ? [] : merge ? [head, extra] : [head],
    authorName: "Fixture",
    authoredAtMs: 1792454400000,
    subject: "feat: 中文 history " + hash.slice(0, 4),
    refs:
      hash === head
        ? [
            { name: "HEAD", kind: "head" },
            { name: "main", kind: "branch" },
          ]
        : [{ name: "feature/history", kind: "branch" }],
  });
  const text = (contents: string) => ({
    kind: "text",
    mode: "100644",
    oid: head,
    size: contents.length,
    text: contents,
    eol: "lf",
  });
  const service = {
    ...base.service,
    locateHistoryCommit: async (params: any) => {
      call("locate", params);
      await wait();
      return { hash: head };
    },
    getHistoryCandidates: async (params: any) => {
      call("candidates", params);
      await wait();
      return {
        revision: revision(),
        refs: [{ value: "refs/heads/feature/中文", label: "feature/中文", kind: "branch" }],
        authors: [
          { name: "Fixture", email: "fixture@example.invalid", value: "fixture@example.invalid" },
        ],
        refsTruncated: false,
        authorsTruncated: false,
        historyTruncated: false,
      };
    },
    getHistory: async (params: any) => {
      call("history", params);
      await wait();
      if (params.expectedRevision && params.expectedRevision !== revision())
        throw new Error("stale-history");
      if (many) {
        const hashes = [
          selected,
          head,
          ...Array.from({ length: typeof many === "number" ? many - 2 : 998 }, (_, index) =>
            (index + 1).toString(16).padStart(40, "0"),
          ),
        ];
        return {
          revision: revision(),
          hasMore: typeof many === "number" && many > 10000,
          commits: hashes.map((hash, index) => ({
            ...commit(hash),
            parents: hashes[index + 1] ? [hashes[index + 1]] : [],
          })),
        };
      }
      return {
        revision: revision(),
        hasMore: !params.skip,
        commits:
          params.search === "none"
            ? []
            : params.skip
              ? [commit(extra)]
              : [commit(selected), commit(head)],
      };
    },
    getHistoryDetail: async (params: any) => {
      call("detail", params);
      await wait();
      return {
        ...commit(params.hash),
        parent: params.parent ?? 1,
        parentHash: params.parent === 2 ? extra : head,
        message: "feat: history\n\n完整中文提交消息\n",
        authorEmail: "fixture@example.invalid",
        committerName: "Committer",
        committerEmail: "committer@example.invalid",
        committedAtMs: 1792454400000,
        files: [{ path: "src/main.ts", status: "M" }],
        filesTruncated: false,
      };
    },
    getHistoryFile: async (params: any) => {
      call("historyFile", params);
      await wait();
      const before = Array.from({ length: 230 }, (_, index) => `line ${index + 1}`);
      if (context)
        return {
          path: params.path,
          before: text(before.join("\n") + "\n"),
          after: text(before.with(120, "changed 中文").join("\n") + "\n"),
        };
      return {
        path: params.path,
        before: text(params.parent === 2 ? "parent two\n" : "parent one\n"),
        after: binary ? { ...text(""), kind: "binary", text: null } : text("changed 中文\n"),
      };
    },
    previewHistoryReset: async (params: any) => {
      call("previewReset", params);
      await wait();
      return {
        root,
        revision: revision(),
        head,
        branch: "main",
        target: params.target,
        mode: params.mode,
        trackedChanges: true,
      };
    },
    previewHistoryResetRecovery: async (params: any) => {
      call("previewResetRecovery", params);
      await wait();
      const backup = receipts.get(params.requestId)!.historyReset!;
      return {
        root,
        revision: revision(),
        head: selected,
        branch: "main",
        target: backup.head,
        mode: "hard",
        trackedChanges: false,
        recovery: backup,
        sourceRequestId: params.requestId,
      };
    },
    resetHistory: async (params: any) => {
      call("resetHistory", params);
      await wait();
      const metadata = params.preview.recovery ?? {
        mode: params.preview.mode,
        head,
        target: params.preview.target,
        branch: "main",
        backupRef: "refs/lcode/history-recovery/fixture/head",
        stashRef: null,
        stashOid: null,
        beforeWorktree: revision(),
        beforeIndex: revision(),
        afterRevision: revision(),
      };
      const receipt: GitNetworkOperation = {
        requestId: params.requestId,
        kind: params.preview.recovery ? "history-reset-restore" : "history-reset",
        status: "success",
        resolved: true,
        startedAt: "2026-10-21T00:00:00Z",
        targetPath: root,
        historyReset: metadata,
      };
      receipts.set(params.requestId, receipt);
      if (lost) {
        lost = false;
        throw new Error("lost-ack");
      }
      return receipt;
    },
    previewHistoryTag: async (params: any) => {
      call("previewTag", params);
      await wait();
      return {
        revision: revision(),
        root,
        hash: params.hash,
        name: params.name,
        message: params.message,
        signed: params.signed,
        signer: params.signed ? "ssh" : null,
      };
    },
    createHistoryTag: async (params: any) => {
      call("createHistoryTag", params);
      await wait();
      const receipt: GitNetworkOperation = {
        requestId: params.requestId,
        kind: "history-tag",
        status: params.preview.revision === revision() ? "success" : "failed",
        targetPath: root,
        tagName: params.preview.name,
        tagOid: extra,
        startedAt: "2026-10-21T00:00:00Z",
        ...(params.preview.revision !== revision() ? { code: "stale-preview" } : {}),
      };
      if (receipt.status === "success")
        tags.set(params.preview.name, {
          name: params.preview.name,
          oid: extra,
          target: params.preview.hash,
          hasSignature: params.preview.signed,
          message: params.preview.message,
        });
      receipts.set(params.requestId, receipt);
      if (lost) {
        lost = false;
        throw new Error("lost-ack");
      }
      return receipt;
    },
    getHistoryTag: async (params: any) => {
      call("inspectTag", params);
      return (
        tags.get(params.name) ?? {
          name: params.name,
          oid: null,
          target: null,
          hasSignature: false,
          message: null,
        }
      );
    },
    getNetworkOperation: async (params: any) =>
      receipts.get(params.requestId) ?? base.service.getNetworkOperation(params),
  } as unknown as IGitService;
  return {
    service,
    externalChange: () => {
      stamp++;
      base.externalChange();
    },
  };
}
