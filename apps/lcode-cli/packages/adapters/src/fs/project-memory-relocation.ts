import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { PROJECT_MEMORY_RECORD_MAX_BYTES } from "@lcode/contracts";
import { memoryError, readMemoryBytes } from "./project-memory-io.js";

export const MemoryOwnerSchema = z
  .object({ schemaVersion: z.literal(1), rootDir: z.string() })
  .strict();
const NAMESPACE_LIMIT = 16;

function workspaceLayout(path: string): string | undefined {
  const portable = path.replaceAll("\\", "/");
  if (
    !/^(?:[A-Za-z]:\/|\/(?!\/))/u.test(portable) ||
    [...portable].some((char) => char.charCodeAt(0) < 32) ||
    portable.split("/").some((p) => p === "." || p === "..")
  )
    return undefined;
  if (portable.endsWith("/.lcode/memory")) return "local";
  return /\/\.lcode\/memories\/([a-f0-9]{16})\/memory$/u.exec(portable)?.[1];
}

/** 搬迁只选择新根的状态空间，旧 owner/journal/lease 原样保留且不在新根恢复。 */
export async function selectMemoryStateDirectory(input: {
  rootDir: string;
  controlDir: string;
  validate: () => Promise<void>;
  prepareDirectory: (path: string) => Promise<void>;
}): Promise<string> {
  await input.validate();
  const bytes = await readMemoryBytes(
    join(input.controlDir, "owner.json"),
    PROJECT_MEMORY_RECORD_MAX_BYTES,
    true,
  );
  if (!bytes) return input.controlDir;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw memoryError("io_error", input.controlDir, "Invalid Project Memory owner JSON");
  }
  const parsed = MemoryOwnerSchema.safeParse(value);
  if (!parsed.success)
    throw memoryError("io_error", input.controlDir, "Invalid Project Memory owner");
  const prior = parsed.data.rootDir;
  if (isAbsolute(prior) && relative(resolve(prior), input.rootDir) === "") return input.controlDir;
  const layout = workspaceLayout(input.rootDir);
  if (!layout || workspaceLayout(prior) !== layout) return input.controlDir;
  const normalized = process.platform === "win32" ? input.rootDir.toLowerCase() : input.rootDir;
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  const namespaces = join(input.controlDir, "relocated");
  await input.prepareDirectory(namespaces);
  const entries = await opendir(namespaces);
  let count = 0;
  let exists = false;
  for await (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{32}$/u.test(entry.name))
      throw memoryError("invalid_path", namespaces, "Invalid Project Memory relocation namespace");
    exists ||= entry.name === key;
    if (++count > NAMESPACE_LIMIT)
      throw memoryError(
        "too_large",
        namespaces,
        "Project Memory relocation namespace capacity exceeded",
      );
  }
  if (!exists && count >= NAMESPACE_LIMIT)
    throw memoryError(
      "too_large",
      namespaces,
      "Project Memory relocation namespace capacity exceeded; existing records were preserved",
    );
  await input.validate();
  return join(namespaces, key);
}
