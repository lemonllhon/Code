import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import type { GitConflictVersion, GitConflictEntry } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitWorkspaceSafety } from "./gitWorkspaceSafety.js";

export const MAX_CONFLICT_TEXT = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024 ** 2;
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const absentVersion = (): GitConflictVersion => ({
  kind: "absent",
  oid: null,
  mode: null,
  size: 0,
  text: null,
  eol: "none",
});
function textVersion(bytes: Buffer, mode: string | null, oid: string | null): GitConflictVersion {
  const base = { ...absentVersion(), mode, oid, size: bytes.length };
  if (bytes.includes(0)) return { ...base, kind: "binary" };
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) return { ...base, kind: "encoding" };
  const crlf = text.includes("\r\n"),
    lf = text.replaceAll("\r\n", "").includes("\n"),
    cr = text.replaceAll("\r\n", "").includes("\r");
  return {
    ...base,
    kind: "text",
    text,
    eol: cr || (crlf && lf) ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none",
  };
}
export async function conflictBlob(
  safety: GitWorkspaceSafety,
  root: string,
  stage: GitConflictEntry["stages"][number] | undefined,
): Promise<GitConflictVersion> {
  if (!stage) return absentVersion();
  const base = { ...absentVersion(), oid: stage.oid, mode: stage.mode };
  if (stage.mode === "160000") return { ...base, kind: "submodule" };
  if (stage.mode === "120000") return { ...base, kind: "symlink" };
  const size = Number((await safety.git(root, ["cat-file", "-s", stage.oid])).trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new GitNetworkError("invalid-conflict");
  if (size > MAX_CONFLICT_TEXT) return { ...base, size, kind: "large" };
  const raw = await safety.git(root, ["cat-file", "blob", stage.oid]);
  const bytes = Buffer.from(raw);
  const computed = createHash(stage.oid.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (computed !== stage.oid || bytes.length !== size)
    return { ...base, size, kind: raw.includes("\0") ? "binary" : "encoding" };
  return textVersion(bytes, stage.mode, stage.oid);
}
export async function readConflictIndex(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return Buffer.alloc(0);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)
    throw new GitNetworkError("unsupported-conflict");
  const bytes = await readFile(path);
  if (bytes.length > MAX_FILE_BYTES) throw new GitNetworkError("unsupported-conflict");
  return bytes;
}
export async function conflictWorking(path: string) {
  const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return { version: absentVersion(), fingerprint: "absent", mode: 0o644 };
  const metadata = [
    String(info.ino),
    String(info.dev),
    String(info.mode),
    String(info.size),
    String(info.mtimeNs),
    String(info.ctimeNs),
  ];
  const base = { ...absentVersion(), size: Number(info.size) };
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_FILE_BYTES))
    return {
      version: {
        ...base,
        kind: info.isSymbolicLink()
          ? ("symlink" as const)
          : info.isDirectory()
            ? ("directory" as const)
            : ("large" as const),
      },
      fingerprint: digest(JSON.stringify(metadata)),
      mode: Number(info.mode & 0o777n),
    };
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    // 先比较句柄身份再读取，避免 lstat 与 open 之间被替换成外部文件链接。
    if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev)
      throw new GitNetworkError("stale-conflict");
    const hash = createHash("sha256"),
      chunks: Buffer[] = [],
      buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const item = await file.read(buffer, 0, buffer.length, null);
      if (!item.bytesRead) break;
      size += item.bytesRead;
      if (size > MAX_FILE_BYTES) throw new GitNetworkError("unsupported-conflict");
      hash.update(buffer.subarray(0, item.bytesRead));
      if (info.size <= BigInt(MAX_CONFLICT_TEXT))
        chunks.push(Buffer.from(buffer.subarray(0, item.bytesRead)));
    }
    const after = await file.stat({ bigint: true }),
      final = await lstat(path, { bigint: true });
    if (
      size !== Number(info.size) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      final.ino !== before.ino ||
      final.isSymbolicLink()
    )
      throw new GitNetworkError("stale-conflict");
    const mode = info.mode & 0o111n ? "100755" : "100644";
    return {
      version:
        info.size > BigInt(MAX_CONFLICT_TEXT)
          ? { ...base, mode, kind: "large" as const }
          : textVersion(Buffer.concat(chunks), mode, null),
      fingerprint: digest(JSON.stringify([...metadata, hash.digest("hex")])),
      mode: Number(info.mode & 0o777n),
    };
  } finally {
    await file.close();
  }
}
