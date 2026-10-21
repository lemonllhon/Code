import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManagementService } from "./gitManagementService.js";
import { gitAccountInputSchema } from "@lcode/shared";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lcode-git-accounts-"));
  const values = new Map<string, string>();
  const service = createGitManagementService({
    home,
    detectionCommand: null,
    credentialMetadataRunner: null,
    lockPath: join(home, "profile"),
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
  return { home, values, service };
}
const account = {
  name: "Test account",
  provider: "github" as const,
  serverUrl: "https://github.com",
  username: "tester",
  auth: "token" as const,
  privateKeyPath: "",
  token: "fixture-secret",
};
test("Git account CRUD is revision checked, retains blank token and never returns secrets", async () => {
  const { service } = await fixture();
  let snapshot = await service.getSnapshot();
  snapshot = await service.mutate({ type: "save", expectedRevision: snapshot.revision, account });
  assert.equal(snapshot.accounts[0]!.hasToken, true);
  assert.ok(!JSON.stringify(snapshot).includes("fixture-secret"));
  await assert.rejects(
    service.mutate({ type: "delete", expectedRevision: "old", id: snapshot.accounts[0]!.id }),
    /revision-conflict/,
  );
  const original = snapshot.accounts[0]!;
  snapshot = await service.mutate({
    type: "save",
    expectedRevision: snapshot.revision,
    account: { ...account, id: original.id, name: "Updated", token: "" },
  });
  assert.notEqual(snapshot.accounts[0]!.revision, original.revision);
  assert.equal(snapshot.accounts[0]!.hasToken, true);
  await assert.rejects(
    service.authentication("https://github.com/a.git", {
      id: original.id,
      revision: original.revision,
    }),
    /stale-account/,
  );
  const auth = await service.authentication("https://github.com/a.git", {
    id: original.id,
    revision: snapshot.accounts[0]!.revision,
  });
  assert.equal(auth.account?.name, "Updated");
  assert.equal(auth.secret, "fixture-secret");
  await assert.rejects(
    service.authentication("https://github.com.evil.invalid/a.git", {
      id: original.id,
      revision: snapshot.accounts[0]!.revision,
    }),
    /account-server-mismatch/,
  );
  snapshot = await service.mutate({
    type: "delete",
    expectedRevision: snapshot.revision,
    id: original.id,
  });
  assert.equal(snapshot.accounts.length, 0);
  await assert.rejects(
    service.authentication("https://github.com/a.git", { id: original.id }),
    /missing-account/,
  );
});
test("Static .ssh/CLI detection does not execute config or expose key/token contents", async () => {
  const { home, service } = await fixture();
  await mkdir(join(home, ".ssh"));
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "private-fixture-never-read");
  await writeFile(
    join(home, ".ssh", "config"),
    'Host work-git\n HostName git.example.invalid\n User git\n IdentityFile ~/.ssh/id_ed25519\nMatch exec "never-run-this"\nHost *\n IdentityFile ignored\n',
  );
  await writeFile(
    join(home, ".config", "gh", "hosts.yml"),
    "github.com:\n  user: fixture-user\n  oauth_token: fixture-cli-secret\n",
  );
  const detection = await service.detect();
  assert.ok(!JSON.stringify(detection).includes("fixture-cli-secret"));
  assert.ok(!JSON.stringify(detection).includes("private-fixture"));
  assert.ok(detection.privateKeyPaths.includes(join(home, ".ssh", "id_ed25519")));
  assert.ok(detection.accounts.some((a) => a.serverUrl.includes("work-git")));
  const candidate = detection.accounts.find((a) => a.username === "fixture-user")!;
  assert.ok(candidate);
  const snapshot = await service.mutate({
    type: "import",
    expectedRevision: (await service.getSnapshot()).revision,
    candidateId: candidate.candidateId,
  });
  const saved = snapshot.accounts.find((a) => a.username === "fixture-user")!;
  assert.equal(saved.hasToken, true);
  assert.equal(
    (await service.authentication("https://github.com/o/r.git", { id: saved.id })).secret,
    "fixture-cli-secret",
  );
  assert.match(await readFile(join(home, ".ssh", "id_ed25519"), "utf8"), /never-read/);
});
test("Corrupt encrypted model is not overwritten and URL paths are bounded", async () => {
  const { service, values } = await fixture();
  values.set("git-management:v1", "{}");
  await assert.rejects(service.getSnapshot());
  await assert.rejects(service.mutate({ type: "save", expectedRevision: "empty", account }));
  assert.equal(values.get("git-management:v1"), "{}");
});
test("Invalid account URLs return validation results and never throw from refinements", () => {
  for (const serverUrl of [
    "https://",
    "not a URL",
    "https://user:password@example.invalid",
    "https://example.invalid/?token=secret",
  ]) {
    assert.equal(gitAccountInputSchema.safeParse({ ...account, serverUrl }).success, false);
  }
});
test("Concurrent profile mutations use CAS and preserve the winning account", async () => {
  const { service } = await fixture();
  const results = await Promise.allSettled([
    service.mutate({ type: "save", expectedRevision: "empty", account }),
    service.mutate({
      type: "save",
      expectedRevision: "empty",
      account: { ...account, name: "Concurrent" },
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await service.getSnapshot()).accounts.length, 1);
});
test("Self-hosted GitLab and tea imports stay classified, SSH Includes are bounded and imports idempotent", async () => {
  const { home, service } = await fixture();
  await mkdir(join(home, ".config", "glab-cli"), { recursive: true });
  await mkdir(join(home, ".config", "tea"), { recursive: true });
  await mkdir(join(home, ".ssh"));
  await writeFile(
    join(home, ".config", "glab-cli", "config.yml"),
    "hosts:\n  gitlab.example.invalid:\n    user: fixture\n    token: fixture-glab-token\n  gitlab:\n    user: internal\n    token: fixture-internal-token\n",
  );
  await writeFile(
    join(home, ".config", "tea", "config.yml"),
    "logins:\n - name: Forgejo\n   url: https://forgejo.example.invalid\n   user: fixture\n   token: fixture-tea-token\n",
  );
  await writeFile(join(home, ".ssh", "config"), "Include extra\nHost *\n User ignored\n");
  await writeFile(join(home, ".ssh", "extra"), "Include config\nHost included\n User git\n");
  const detection = await service.detect();
  assert.ok(
    detection.accounts.some(
      (a) => a.provider === "gitlab" && a.serverUrl.includes("gitlab.example.invalid"),
    ),
  );
  assert.ok(detection.accounts.some((a) => a.provider === "gitea" && a.name === "Forgejo"));
  assert.ok(
    detection.accounts.some((a) => a.provider === "gitlab" && a.serverUrl === "https://gitlab"),
  );
  const included = detection.accounts.find((a) => a.name === "included")!;
  assert.ok(included);
  let snapshot = await service.mutate({
    type: "import",
    expectedRevision: "empty",
    candidateId: included.candidateId,
  });
  const revision = snapshot.revision;
  snapshot = await service.mutate({
    type: "import",
    expectedRevision: revision,
    candidateId: included.candidateId,
  });
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.revision, revision);
});
