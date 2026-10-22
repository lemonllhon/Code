import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitCommandProvider } from "../git/node.js";
import { createGitBackupSource } from "./gitBackupRestore.js";
test("real Git backup restores commits and tracked files to an empty target without running hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "backup-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "source");
  await mkdir(workspace);
  const command = createGitCommandProvider();
  const git = async (args: string[]) => {
    const result = await command.run({
      cwd: workspace,
      args: ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    });
    assert.equal(result.exitCode, 0, `${args[0]}: ${result.stderr} ${result.stdout}`);
    return result.stdout.trim();
  };
  await git(["init"]);
  await writeFile(join(workspace, "tracked.txt"), "committed\n");
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const head = await git(["rev-parse", "HEAD"]);
  await writeFile(join(workspace, "tracked.txt"), "uncommitted\n");
  await writeFile(join(workspace, ".git", "hooks", "post-checkout"), "#!/bin/sh\ntouch hook-ran\n");
  const source = createGitBackupSource({ commandProvider: command });
  const snapshot = await source.capture(undefined, { workspacePath: workspace });
  const request = {
    id: "fixture",
    location: "local" as const,
    locationRevision: "fixture",
    mode: "merge" as const,
    destinationPath: join(root, "restored"),
  };
  const preview = await source.inspect(snapshot, request);
  await source.restore(snapshot, request, preview.revision, "operation");
  assert.equal(await readFile(join(root, "restored", "tracked.txt"), "utf8"), "committed\n");
  const restored = await command.run({ cwd: join(root, "restored"), args: ["rev-parse", "HEAD"] });
  assert.equal(restored.stdout.trim(), head);
  await assert.rejects(access(join(root, "restored", "hook-ran")));
  await access(join(root, "restored", ".git", "lcode-backup-disabled-hooks", "post-checkout"));
  await assert.rejects(source.inspect(snapshot, request), /new or empty/);
  const dangerous = structuredClone(snapshot);
  (dangerous.data as { files: { path: string }[] }).files[0]!.path = "../escape";
  await assert.rejects(
    source.inspect(dangerous, { ...request, destinationPath: join(root, "safe") }),
    /Unsafe/,
  );
  await assert.rejects(access(join(root, "escape")));
});
