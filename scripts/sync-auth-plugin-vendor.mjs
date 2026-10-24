import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit maintenance command; never runs while a user signs in.
const revision = "5d5d86e2251169e0f5c0fd7a884957ac2dbe184a";
const overrides = {
  zcode: { revision: "d1b65007ffd3e271fd1e4e95afc2b6965fc48538", version: "0.1.24" },
};
const names = [
  "cline",
  "commandcode",
  "cursor",
  "devin",
  "factory",
  "grok",
  "kiro",
  "minimax",
  "mimo",
  "qoder",
  "trae",
  "workbuddy",
  "zcode",
  "zed",
  "zen-free",
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error("Usage: node scripts/sync-auth-plugin-vendor.mjs <plugins-checkout>");
const git = promisify(execFile);
// 修复：单包升级不能连带更新其他供应商；按固定 Git 对象读取也不会混入工作区改动。
async function snapshot(ref, file) {
  const { stdout } = await git("git", ["show", `${ref}:${file}`], {
    cwd: source,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  // 旧快照由 Windows checkout 导入，哈希包含 CRLF；只保留其既有字节，新 pin 使用 Git 原字节。
  return ref === revision ? Buffer.from(stdout.toString("utf8").replace(/\r?\n/g, "\r\n")) : stdout;
}
async function writeSnapshot(file, bytes) {
  try {
    if ((await readFile(file)).equals(Buffer.from(bytes))) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, bytes);
}
const destination = join(root, "packages/provider-node/src/provider-auth/vendor");
await mkdir(destination, { recursive: true });
await writeSnapshot(join(destination, "LICENSE"), await snapshot(revision, "LICENSE"));
const manifest = {
  repository: "https://github.com/magpie-community/plugins",
  revision,
  packages: [],
};
for (const name of names) {
  const pin = overrides[name];
  const ref = pin?.revision ?? revision;
  const folder = `packages/${name}`;
  const read = (file) => snapshot(ref, `${folder}/${file}`);
  const pkg = JSON.parse((await read("package.json")).toString("utf8"));
  if (pin && pkg.version !== pin.version) throw new Error(`Unexpected ${name} version at ${ref}`);
  const files = new Set(["index.mjs"]);
  // Copy only transitive runtime modules, never tests, installation hooks or credentials.
  for (const file of files) {
    const content = (await read(file)).toString("utf8");
    for (const match of content.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+)["']/g)) {
      if (match[1].endsWith(".mjs")) files.add(match[1].slice(2));
    }
  }
  const copied = [];
  for (const file of files) {
    const bytes = await read(file);
    const target = join(destination, name, file + ".source");
    await mkdir(dirname(target), { recursive: true });
    // .source keeps immutable third-party code out of TypeScript/lint. The build script
    // loads it as JavaScript and embeds the complete bundle in a static TS import.
    await writeSnapshot(target, bytes);
    copied.push({
      file: file + ".source",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const { stdout: listing } = await git("git", ["ls-tree", "--name-only", `${ref}:${folder}`], {
    cwd: source,
    windowsHide: true,
  });
  for (const file of listing.trim().split("\n")) {
    if (!file.startsWith("LICENSE")) continue;
    await writeSnapshot(join(destination, name, file), await read(file));
  }
  manifest.packages.push({
    directory: name,
    name: pkg.name,
    version: pkg.version,
    ...(pin ? { revision: ref } : {}),
    license: pkg.license,
    files: copied,
  });
}
await writeSnapshot(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Vendored ${manifest.packages.length} provider packages at ${revision}\n`);
