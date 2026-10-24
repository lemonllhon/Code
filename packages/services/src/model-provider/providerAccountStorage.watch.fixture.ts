import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchProviderAccountStorage } from "./providerAccountStorage.js";

const directory = await mkdtemp(join(tmpdir(), "account-watch-pressure-"));
await mkdir(directory, { recursive: true });
const file = join(directory, "credentials.fixture.json");
await writeFile(file, "0");
let warnings = 0;
const onWarning = (warning: Error) => {
  if (warning.message === "fs.watch maxQueue exceeded") warnings++;
};
process.on("warning", onWarning);
let release!: () => void;
const blocked = new Promise<void>((resolve) => (release = resolve));
let entered!: () => void;
const started = new Promise<void>((resolve) => (entered = resolve));
let caughtUp!: () => void;
const latest = new Promise<void>((resolve) => (caughtUp = resolve));
let active = 0,
  maxActive = 0;
const observed: string[] = [];
const watcher = watchProviderAccountStorage(file, async () => {
  active++;
  maxActive = Math.max(active, maxActive);
  try {
    const value = await readFile(file, "utf8");
    observed.push(value);
    if (observed.length === 1) {
      entered();
      await blocked;
    }
    if (value === "2") caughtUp();
  } finally {
    active--;
  }
});
try {
  await watcher.ready;
  await writeFile(file, "1");
  await started;
  // 独立进程内只阻塞合成读取；真实目录事件必须超过 Node 迭代器默认容量。
  for (let index = 0; index < 3500; index++)
    await writeFile(join(directory, "unrelated.tmp"), String(index));
  await writeFile(file, "2");
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finalRead = await Promise.race([
    latest.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1000);
    }),
  ]);
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ warnings, maxActive, observed, finalRead }));
} finally {
  release();
  watcher.dispose();
  process.removeListener("warning", onWarning);
  await rm(directory, { recursive: true, force: true });
}
