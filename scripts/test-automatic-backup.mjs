import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
async function testFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? testFiles(`${directory}/${entry.name}`)
          : entry.name.endsWith(".test.ts")
            ? [`${directory}/${entry.name}`]
            : [],
      ),
    )
  ).flat();
}
async function run(files, cwd = root) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=4", ...files],
    { cwd, windowsHide: true, stdio: "inherit" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
if (process.argv.includes("--ui")) {
  await run([
    "packages/web/test/automatic-backup.test.mjs",
    "packages/web/test/settings-sidebar-order.test.mjs",
    "packages/web/test/git-backup-workspaces.test.mjs",
  ]);
} else {
  const ownerTests = (await readdir(join(root, "packages/services/src/model-provider")))
    .filter((file) => /^provider(?:Backup|Account|Accounts).*\.test\.ts$/.test(file))
    .map((file) => `packages/services/src/model-provider/${file}`);
  await run([
    ...(await testFiles("packages/services/src/backup")),
    ...(await testFiles("packages/services/src/git-backup")),
    ...ownerTests,
    "packages/client/src/remoteServiceAccess.gitBackup.test.ts",
    "packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.gitBackup.test.ts",
  ]);
  await run(
    [
      "src/settings/settingsPageConfig.test.ts",
      "src/settings/GitBackupSection.test.tsx",
      "src/hooks/useGitBackup.test.ts",
    ],
    join(root, "packages/ui"),
  );
}
