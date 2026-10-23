import type { BackupObjectStore } from "../backup/node.js";
import {
  getGitBackupDestinationLocation,
  type GitBackupDestinationConfig,
  type GitBackupMinioConfig,
  type GitBackupOssConfig,
  type GitBackupProvider,
} from "./gitBackup.js";
import { requestOssObject, type OssRequestOptions } from "./gitBackupOssClient.js";
import { requestMinioObject } from "./gitBackupMinioClient.js";
function xmlText(value: string): string {
  return value.replace(
    /&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|apos);/gi,
    (_all, hex, decimal, name) =>
      hex
        ? String.fromCodePoint(Number.parseInt(hex, 16))
        : decimal
          ? String.fromCodePoint(Number(decimal))
          : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name]!,
  );
}
function parseBackupObjectList(text: string, prefix: string, provider: GitBackupProvider) {
  if (
    text.length > 4 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    !/<ListBucketResult[\s>]/.test(text)
  )
    throw new Error("Invalid backup object listing");
  const tag = (name: string) =>
    xmlText(text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "");
  const keys = [...text.matchAll(/<Contents>\s*([\s\S]*?)<\/Contents>/g)].map((match) => {
    const encoded = match[1]!.match(/<Key>([^<]*)<\/Key>/)?.[1];
    if (encoded === undefined) throw new Error("Invalid backup object listing key");
    const key = decodeURIComponent(xmlText(encoded));
    if (
      !key.startsWith(prefix) ||
      key
        .slice(prefix.length)
        .split("/")
        .some((x) => x === ".." || x === ".")
    )
      throw new Error("Object listing escaped the backup prefix");
    return key;
  });
  const truncated = tag("IsTruncated") === "true";
  const cursor =
    provider === "minio"
      ? tag("NextContinuationToken")
      : decodeURIComponent(tag("NextMarker")) || keys.at(-1) || "";
  if (truncated && !cursor) throw new Error("Object listing is truncated without a cursor");
  return { keys, cursor: truncated ? cursor : null };
}
export function createBackupCloudStore(
  provider: GitBackupProvider,
  config: GitBackupDestinationConfig,
  options: OssRequestOptions,
  legacy = false,
): BackupObjectStore {
  const base = config.pathPrefix ? `${config.pathPrefix}/` : "";
  const request = (
    key: string,
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    data?: Uint8Array,
    query?: URLSearchParams,
  ) =>
    provider === "oss"
      ? requestOssObject(
          config as GitBackupOssConfig,
          key,
          method,
          data ? Buffer.from(data) : undefined,
          data ? "application/octet-stream" : "",
          options,
          query,
        )
      : requestMinioObject(
          config as GitBackupMinioConfig,
          key,
          method,
          data ? Buffer.from(data) : undefined,
          data ? "application/octet-stream" : "",
          options,
          query,
        );
  const key = (relative: string) => {
    if (
      !(legacy
        ? /^[a-f0-9]{24}\/backup-[A-Za-z0-9.-]+-[a-f0-9]{16}\/(manifest\.json|data\.enc|key\.enc|iv\.bin|tombstone\.deleted)$/.test(
            relative,
          )
        : /^lcode-backup\/v2\/[A-Za-z0-9/_-]+\.(json|deleted)$/.test(relative))
    )
      throw new Error("Invalid backup object key");
    return `${base}${relative}`;
  };
  return {
    location: provider,
    revision: getGitBackupDestinationLocation(config),
    async put(relative, data) {
      await request(key(relative), "PUT", data);
    },
    async get(relative) {
      const result = await request(key(relative), "GET");
      return result.statusCode === 404 ? null : result.bytes;
    },
    async exists(relative) {
      return (await request(key(relative), "HEAD")).statusCode !== 404;
    },
    async remove(relative) {
      await request(key(relative), "DELETE");
    },
    async list(prefix) {
      if (prefix !== (legacy ? "" : "lcode-backup/v2/"))
        throw new Error("Invalid backup catalog prefix");
      const results: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({
          prefix: `${base}${prefix}`,
          "encoding-type": "url",
          "max-keys": "1000",
        });
        if (provider === "minio") query.set("list-type", "2");
        if (cursor) query.set(provider === "minio" ? "continuation-token" : "marker", cursor);
        const response = await request("", "GET", undefined, query);
        const parsed = parseBackupObjectList(
          Buffer.from(response.bytes).toString("utf8"),
          `${base}${prefix}`,
          provider,
        );
        results.push(...parsed.keys.map((value) => value.slice(base.length)));
        cursor = parsed.cursor;
        if (cursor && seen.has(cursor)) throw new Error("Backup catalog cursor repeated");
        if (cursor) seen.add(cursor);
        if (results.length > 100_000) throw new Error("Backup catalog exceeds the listing limit");
      } while (cursor);
      return results;
    },
  };
}
