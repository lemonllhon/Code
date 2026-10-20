import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

// 与存储 Repo 保持同一加载边界，避免打包器把 node:sqlite 改写成 npm 包。
const { DatabaseSync, backup } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
const DATA_ROOT_NAME = ".lcode";
const STAGING_PREFIX = ".lcode-migration-";
const BOOTSTRAP_SETTINGS = join("v2", "setting.json");
const SESSION_DATABASE = join("cli", "db", "db.sqlite");
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db"]);
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isBootstrapSettings(path: string): boolean {
  return path === BOOTSTRAP_SETTINGS || path.startsWith(`${BOOTSTRAP_SETTINGS}.`);
}

/** 目标可尚未创建；先解析已存在的祖先，防止目录链接绕过重叠校验。 */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error) || dirname(path) === path) throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function assertTargetMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("Data directory migration target already exists");
}

async function isSqlite(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    await file.close();
  }
}

async function findDatabases(root: string, directory = ""): Promise<string[]> {
  const databases: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (isBootstrapSettings(path) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) databases.push(...(await findDatabases(root, path)));
    else if (entry.isFile()) {
      // 必需数据库即使已损坏也必须进入备份校验，不能当作普通文件复制并提交路径。
      const required =
        path === SESSION_DATABASE || (dirname(path) === "v2" && extname(path) === ".sqlite");
      if (
        required ||
        (SQLITE_EXTENSIONS.has(extname(path).toLowerCase()) && (await isSqlite(join(root, path))))
      )
        databases.push(path);
    }
  }
  return databases;
}

async function backupDatabase(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    // 活跃库的新会话可能只在 WAL；分别 cp 主库和 sidecar 不能保证同一提交水位。
    await backup(database, target);
  } finally {
    database.close();
  }
}

/** 完整复制数据根的保存时快照；全部成功后发布，固定引导设置仍由 SettingService 保存。 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  const sourceRoot = await realpath(resolve(oldBaseDir, DATA_ROOT_NAME));
  const targetBase = await canonicalDestination(resolve(newBaseDir));
  const targetRoot = join(targetBase, DATA_ROOT_NAME);
  if (relative(sourceRoot, targetRoot) === "") return;
  if (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot))
    throw new Error("Data directory migration roots must not overlap");
  await assertTargetMissing(targetRoot);
  await mkdir(targetBase, { recursive: true });
  const stagingRoot = await mkdtemp(join(targetBase, STAGING_PREFIX));
  let published = false;
  try {
    // 原实现只复制 v2，留下任务索引却遗漏 cli 中的会话和产物，重启后便无法冷恢复。
    const databases = await findDatabases(sourceRoot);
    const excluded = new Set(
      databases.flatMap((path) => [path, ...SQLITE_SIDECARS.map((suffix) => `${path}${suffix}`)]),
    );
    // 先固定任务入口、再固定会话事实；数据库之后才遍历复制其引用的附件与工具产物。
    databases.sort(
      (left, right) => Number(right.startsWith(`v2${sep}`)) - Number(left.startsWith(`v2${sep}`)),
    );
    for (const path of databases)
      await backupDatabase(join(sourceRoot, path), join(stagingRoot, path));
    await cp(sourceRoot, stagingRoot, {
      recursive: true,
      force: false,
      filter: async (source) => {
        const path = relative(sourceRoot, source);
        if (isBootstrapSettings(path) || excluded.has(path)) return false;
        // 不跟随链接，也不让临时消失的 bootstrap lock 触发无关的文件读取。
        return !(await lstat(source)).isSymbolicLink();
      },
    });
    await assertTargetMissing(targetRoot);
    await rename(stagingRoot, targetRoot);
    published = true;
  } finally {
    // 只清理本次 mkdtemp 创建且仍位于目标父目录的临时根，绝不删除已发布或已有数据。
    if (
      !published &&
      dirname(stagingRoot) === targetBase &&
      basename(stagingRoot).startsWith(STAGING_PREFIX)
    )
      await rm(stagingRoot, { recursive: true, force: true });
  }
}
