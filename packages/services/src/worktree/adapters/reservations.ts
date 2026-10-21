import { createHash } from "node:crypto";
import { readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import type { CheckoutReservation } from "../nodeTypes.js";

const recordSchema = z
  .object({
    workspacePath: z.string(),
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum([
      "repository-acquisition",
      "stash-save",
      "stash-apply",
      "conflict-resolution",
      "integration",
    ]),
  })
  .strict();
const normalize = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
export class CheckoutReservedError extends Error {
  readonly code = "LCODE_CHECKOUT_RESERVED";
  constructor() {
    super("LCODE_CHECKOUT_RESERVED: checkout has an unresolved Git operation");
  }
}

/** 只有资源路径与原操作 key；Git 业务事实仍由原 journal 所有。 */
export function createCheckoutReservations(dataDir: string) {
  const pathKey = (path: string) => createHash("sha256").update(normalize(path)).digest("hex");
  const location = (path: string) =>
    join(dataDir, "checkout-reservations", `${pathKey(path)}.json`);
  const canonical = async (path: string): Promise<string> => {
    let directory = resolve(path);
    const tail: string[] = [];
    // admission 也检查尚未创建或已移除的子目录；逐级定位真实祖先，保留原有生命周期 fence 的判断机会。
    while (true) {
      try {
        return join(await realpath(directory), ...tail);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(directory) === directory)
          throw error;
        tail.unshift(basename(directory));
        directory = dirname(directory);
      }
    }
  };
  async function read(path: string): Promise<CheckoutReservation | null> {
    try {
      const record = recordSchema.parse(JSON.parse(await readFile(location(path), "utf8")));
      if (normalize(record.workspacePath) !== normalize(path)) throw new CheckoutReservedError();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function getReservation(params: { workspacePath: string }) {
    const requested = await canonical(params.workspacePath);
    let path = requested;
    while (true) {
      const record = await read(path);
      if (record) return record;
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    let entries: string[];
    try {
      entries = await readdir(join(dataDir, "checkout-reservations"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const name of entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
      let record: CheckoutReservation;
      try {
        record = recordSchema.parse(
          JSON.parse(await readFile(join(dataDir, "checkout-reservations", name), "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (`${pathKey(record.workspacePath)}.json` !== name) throw new CheckoutReservedError();
      const child = relative(normalize(requested), normalize(record.workspacePath));
      if (child && !child.startsWith("..") && !isAbsolute(child)) return record;
    }
    return null;
  }
  return {
    getReservation,
    async assertAdmission(params: { workspacePath: string }, allowKey?: string) {
      const record = await getReservation(params);
      if (record && record.operationKey !== allowKey) throw new CheckoutReservedError();
    },
    async setReservation(input: CheckoutReservation) {
      const workspacePath = await canonical(input.workspacePath);
      const record = recordSchema.parse({ ...input, workspacePath });
      const path = location(workspacePath);
      await withFileLock(path, async () => {
        const current = await getReservation({ workspacePath });
        if (current && current.operationKey !== record.operationKey)
          throw new CheckoutReservedError();
        await atomicWritePrivateTextFile(path, JSON.stringify(record));
      });
    },
    async clearReservation(params: { workspacePath: string; operationKey: string }) {
      const path = await canonical(params.workspacePath);
      await withFileLock(location(path), async () => {
        const current = await read(path);
        if (!current) return;
        if (current.operationKey !== params.operationKey) throw new CheckoutReservedError();
        await unlink(location(path));
      });
    },
  };
}
