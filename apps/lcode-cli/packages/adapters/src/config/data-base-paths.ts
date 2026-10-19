import { join } from "node:path";

/** Desktop/Web 与 CLI 必须使用同一资料根，不能只隔离 Provider 而遗漏会话和记忆。 */
export function dataBaseStoragePaths(env: Record<string, string | undefined>, prefix = "LCODE_") {
  const base =
    env[`${prefix}DATA_BASE_DIR`]?.trim() ||
    (prefix === "LCODE_" ? env.ZCODE_DATA_BASE_DIR?.trim() : undefined);
  if (!base) return undefined;
  const root = join(base, ".lcode");
  const cli = join(root, "cli");
  return { root, cli, database: join(cli, "db", "db.sqlite") };
}
