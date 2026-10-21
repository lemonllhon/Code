import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitManagementService } from "./gitManagementService.js";
import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";

test("System/CLI aggregation keeps both users, deduplicates sources, classifies custom servers and revalidates imports", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-system-discovery-")),
    values = new Map<string, string>();
  await mkdir(join(home, ".config/glab-cli"), { recursive: true });
  await writeFile(
    join(home, ".config/glab-cli/config.yml"),
    "hosts:\n  code.example.invalid:\n    user: alice\n    token: fixture-alice-token\n",
  );
  let items = [
    { target: "git:https://code.example.invalid", userName: "alice" },
    { target: "git:https://bob@code.example.invalid", userName: "bob" },
    { target: "git:https://bitbucket.org", userName: "bb-one" },
    { target: "git:https://bb-two@bitbucket.org", userName: "bb-two" },
  ];
  const runner: GitCredentialMetadataRunner = async () => ({
    status: "ok",
    stdout: JSON.stringify({ items, partial: false }),
  });
  const service = createGitManagementService({
    home,
    platform: "win32",
    lockPath: join(home, "profile"),
    detectionCommand: null,
    credentialMetadataRunner: runner,
    credentials: {
      load: async (k) => values.get(k) ?? null,
      save: async (k, v) => {
        values.set(k, v);
      },
      delete: async (k) => {
        values.delete(k);
      },
    },
  });
  t.after(() => service.dispose());
  const result = await service.detect();
  assert.equal(result.accounts.length, 4);
  assert.equal(result.accounts.find((a) => a.username === "alice")!.source, "gitlab CLI");
  assert.equal(result.accounts.find((a) => a.username === "bob")!.provider, "gitlab");
  assert.equal(result.accounts.filter((a) => a.serverUrl === "https://bitbucket.org").length, 2);
  assert.ok(!JSON.stringify(result).includes("fixture-alice-token"));
  const candidate = result.accounts.find((a) => a.username === "bob")!;
  items = items.filter((a) => a.userName !== "bob");
  await assert.rejects(
    service.mutate({
      type: "import",
      expectedRevision: "empty",
      candidateId: candidate.candidateId,
    }),
    /detected-account-changed/,
  );
  items.push({ target: "git:https://bob@code.example.invalid", userName: "bob" });
  const snapshot = await service.mutate({
    type: "import",
    expectedRevision: "empty",
    candidateId: candidate.candidateId,
  });
  assert.equal(snapshot.accounts[0]!.auth, "system");
  assert.equal(snapshot.accounts[0]!.username, "bob");
  assert.ok(![...values.values()].join("").includes("fixture-alice-token"));
});
