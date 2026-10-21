import type {
  GitHistoryTagOptions,
  GitHistoryTagQuery,
  GitCreateHistoryTagRequest,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import {
  fingerprint,
  type GitOperationCheckpoint,
  type GitOperationEffect,
} from "./gitWorkspaceSafety.js";
import type { GitHistoryRepo } from "./gitHistoryRepo.js";

export class GitHistoryTagRepo {
  constructor(readonly history: GitHistoryRepo) {}
  async inspect(params: GitHistoryTagQuery) {
    const { safety } = this.history,
      root = await safety.state.root(params.workspacePath);
    const oid = (
      await safety.git(
        root,
        ["rev-parse", "--verify", "--quiet", `refs/tags/${params.name}`],
        [0, 1],
      )
    ).trim();
    if (!oid)
      return { name: params.name, oid: null, target: null, message: null, hasSignature: false };
    const target =
      (
        await safety.git(
          root,
          ["rev-parse", "--verify", "--quiet", `refs/tags/${params.name}^{commit}`],
          [0, 1],
        )
      ).trim() || null;
    const type = (await this.history.git(root, ["cat-file", "-t", oid])).trim();
    if (type !== "tag")
      return { name: params.name, oid, target, message: null, hasSignature: false };
    const raw = await this.history.object(root, "tag", oid),
      content = raw.slice(raw.indexOf("\n\n") + 2);
    return {
      name: params.name,
      oid,
      target,
      message: content,
      hasSignature: /^-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----\r?$/m.test(
        content,
      ),
    };
  }
  async preview(params: GitHistoryTagOptions) {
    const { safety } = this.history,
      root = await safety.state.root(params.workspacePath);
    if ((await this.inspect(params)).oid) throw new GitNetworkError("tag-exists");
    const target = (
      await this.history.git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${params.hash}^{commit}`,
      ])
    ).trim();
    if (target !== params.hash) throw new GitNetworkError("invalid-target");
    const config = await safety.git(
      root,
      [
        "config",
        "--null",
        "--get-regexp",
        "^(user\\.(name|email|signingkey)|gpg\\.|tag\\.gpgSign)$",
      ],
      [0, 1],
    );
    const signingKey = (
      await safety.git(root, ["config", "--get", "user.signingkey"], [0, 1])
    ).trim();
    const format =
      (await safety.git(root, ["config", "--get", "gpg.format"], [0, 1])).trim() || "openpgp";
    if (params.signed && !signingKey) throw new GitNetworkError("signer-not-configured");
    return {
      root,
      hash: target,
      name: params.name,
      message: params.message,
      signed: params.signed,
      signer: params.signed ? format : null,
      revision: fingerprint([root, target, params.name, params.message, params.signed, config]),
    };
  }
  async create(
    params: GitCreateHistoryTagRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { safety } = this.history,
      preview = params.preview;
    const actual = await this.preview({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      hash: preview.hash,
      name: preview.name,
      message: preview.message,
      signed: preview.signed,
    });
    if (
      Object.entries(actual).some(([key, value]) => preview[key as keyof typeof preview] !== value)
    )
      throw new GitNetworkError("stale-preview");
    await checkpoint({ targetPath: actual.root, tagName: actual.name, before: actual.hash });
    try {
      const result = await safety.command.run({
        cwd: actual.root,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "tag.gpgSign=false",
          "-c",
          "maintenance.auto=false",
          "-c",
          "gc.auto=0",
          "tag",
          preview.signed ? "--sign" : "--annotate",
          ...(!preview.signed ? ["--no-sign"] : []),
          "--cleanup=verbatim",
          "--message",
          // verbatim 不补末尾换行；签名块会紧贴最后一行，必须先规范终止符再交给原生 signer。
          preview.message + "\n",
          "--",
          preview.name,
          preview.hash,
        ],
        timeoutMs: 120_000,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
      });
      if (result.orphaned)
        return {
          status: "unknown",
          targetPath: actual.root,
          tagName: actual.name,
          code: "writer-unsettled",
          unsettled: true,
        };
      const info = await this.inspect({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        name: preview.name,
      });
      const success =
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.outputTruncated &&
        info.oid &&
        info.target === preview.hash &&
        info.message?.startsWith(preview.message) &&
        (!preview.signed || info.hasSignature);
      return {
        targetPath: actual.root,
        tagName: actual.name,
        ...(info.oid ? { tagOid: info.oid } : {}),
        after: info.target,
        status: success
          ? "success"
          : result.timedOut || result.outputTruncated || result.exitCode === null || info.oid
            ? "unknown"
            : "failed",
        ...(!success
          ? {
              code:
                info.oid || result.timedOut || result.outputTruncated
                  ? "tag-outcome-unknown"
                  : "tag-command-failed",
            }
          : {}),
      };
    } catch {
      return {
        status: "unknown",
        targetPath: actual.root,
        tagName: actual.name,
        code: "tag-outcome-unknown",
      };
    }
  }
}
