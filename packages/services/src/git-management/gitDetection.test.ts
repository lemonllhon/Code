import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { detectGitAccounts } from "./gitDetection.js";
import { createGitManagementService } from "./gitManagementService.js";
import { gitManagementDetectionSchema } from "@lcode/shared";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lcode-git-detection-"));
  const put = async (path: string, content: string) => {
    const target = join(home, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  };
  return { home, put };
}
const command = (stdout: string, exitCode = 0): GitCommandProvider => ({
  resolveGitBinary: async () => "/fixture/git",
  run: async (input) => ({
    ...input,
    binaryPath: "/fixture/git",
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    durationMs: 0,
    timedOut: false,
    outputTruncated: false,
  }),
});

test("GCM lists both GitHub accounts without querying tokens and imports the selected system account", async () => {
  const { home } = await fixture();
  const raw = command("alice\nbob\n"),
    calls: string[][] = [];
  const values = new Map<string, string>();
  const service = createGitManagementService({
    home,
    credentialMetadataRunner: null,
    lockPath: join(home, "profile"),
    credentials: {
      load: async (k) => values.get(k) ?? null,
      save: async (k, value) => {
        values.set(k, value);
      },
      delete: async (k) => {
        values.delete(k);
      },
    },
    detectionCommand: {
      ...raw,
      run: async (input) => {
        calls.push(input.args);
        if (input.args[0] === "config")
          return { ...(await raw.run(input)), stdout: "", exitCode: 1 };
        assert.equal(input.env?.GIT_TERMINAL_PROMPT, "0");
        assert.equal(input.env?.GCM_INTERACTIVE, "Never");
        assert.ok(input.timeoutMs! <= 5000 && input.maxOutputBytes! <= 65536);
        return raw.run(input);
      },
    },
  });
  const detection = await service.detect();
  assert.deepEqual(
    detection.accounts.map((a) => a.username),
    ["alice", "bob"],
  );
  assert.ok(detection.accounts.every((a) => a.auth === "system" && a.provider === "github"));
  assert.equal(new Set(detection.accounts.map((a) => a.candidateId)).size, 2);
  const saved = await service.mutate({
    type: "import",
    expectedRevision: "empty",
    candidateId: detection.accounts[1]!.candidateId,
  });
  assert.equal(saved.accounts[0]!.username, "bob");
  assert.equal(saved.accounts[0]!.hasToken, false);
  assert.ok(
    calls
      .filter((args) => args[0] !== "config")
      .every((args) => args.join(" ") === "credential-manager github list --no-ui"),
  );
});

test("gh multi-user detection never assigns the active user's token to another user", async () => {
  const { home, put } = await fixture();
  await put(
    ".config/gh/hosts.yml",
    "github.com:\n  user: alice\n  oauth_token: alice-secret\n  users:\n    alice:\n    bob:\n    carol:\n      oauth_token: carol-secret\n",
  );
  const result = await detectGitAccounts(home);
  assert.equal(result.entries.length, 3);
  assert.equal(
    result.entries.find((e) => e.account.username === "alice")!.account.token,
    "alice-secret",
  );
  assert.equal(result.entries.find((e) => e.account.username === "bob")!.account.token, undefined);
  assert.equal(result.entries.find((e) => e.account.username === "bob")!.account.auth, "system");
  assert.equal(
    result.entries.find((e) => e.account.username === "carol")!.account.token,
    "carol-secret",
  );
  assert.ok(!JSON.stringify(result.entries.map((e) => e.metadata)).includes("-secret"));
});

test("Windows/macOS/Linux CLI paths and overrides enumerate all providers and credential-file users", async () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const { home, put } = await fixture();
    const gh = platform === "win32" ? "roaming/GitHub CLI" : ".config/gh";
    await put(`${gh}/hosts.yml`, "github.com:\n  users:\n    first:\n    second:\n");
    await put(
      ".config/glab-cli/config.yml",
      "hosts:\n  gitlab.company.invalid:\n    user: lab\n    token: lab-secret\n",
    );
    const tea =
      platform === "darwin"
        ? "Library/Application Support/tea"
        : platform === "win32"
          ? "roaming/tea"
          : ".config/tea";
    await put(
      `${tea}/config.yml`,
      "logins:\n - name: Forgejo\n   url: https://codeberg.org\n   user: forge\n   token: forge-secret\n",
    );
    await put(
      ".git-credentials",
      "https://bituser:fixture-secret@bitbucket.org\nhttps://another:other-secret@bitbucket.org\nhttps://custom:custom-secret@git.company.invalid/team\n",
    );
    const result = await detectGitAccounts(
      home,
      undefined,
      { APPDATA: join(home, "roaming") },
      { platform },
    );
    assert.deepEqual(
      result.entries.filter((e) => e.account.provider === "github").map((e) => e.account.username),
      ["first", "second"],
    );
    assert.ok(
      result.entries.some((e) => e.account.provider === "gitlab" && e.account.username === "lab"),
    );
    assert.ok(
      result.entries.some((e) => e.account.provider === "gitea" && e.account.username === "forge"),
    );
    assert.equal(
      result.entries.filter((e) => e.account.serverUrl === "https://bitbucket.org").length,
      2,
    );
    assert.ok(
      result.entries.some((e) => e.account.serverUrl === "https://git.company.invalid/team"),
    );
    assert.ok(!JSON.stringify(result.entries.map((e) => e.metadata)).includes("secret"));
    await put("override/hosts.yml", "github.enterprise.invalid:\n  user: enterprise\n");
    const overridden = await detectGitAccounts(
      home,
      undefined,
      { GH_CONFIG_DIR: join(home, "override") },
      { platform },
    );
    assert.equal(overridden.entries.filter((e) => e.account.provider === "github").length, 1);
  }
});

test("GCM failure is isolated; SSH aliases classify by HostName and custom IdentityFile keys are listed", async () => {
  const { home, put } = await fixture();
  await put(
    ".ssh/config",
    "Host work-github\n HostName github.com\n User git\n IdentityFile ~/.ssh/work-key\nMatch exec never-run\n User ignored\n",
  );
  await put(".ssh/work-key", "private-fixture-never-read");
  await put(".config/gh/hosts.yml", "github.com:\n user: fixture\n");
  const result = await detectGitAccounts(home, undefined, {}, { command: command("", 1) });
  assert.ok(
    result.entries.some((e) => e.account.provider === "github" && e.account.name === "work-github"),
  );
  assert.ok(result.privateKeyPaths.includes(join(home, ".ssh/work-key")));
  assert.ok(result.entries.some((e) => e.account.username === "fixture"));
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});

test("Timed-out or truncated GCM results cannot introduce partial accounts; legacy Host detection remains readable", async () => {
  const { home, put } = await fixture();
  await put(".config/gh/hosts.yml", "github.com:\n user: known\n");
  for (const flag of ["timedOut", "outputTruncated"] as const) {
    const raw = command("partial-user\n");
    const result = await detectGitAccounts(
      home,
      undefined,
      {},
      {
        command: {
          ...raw,
          run: async (input) => ({ ...(await raw.run(input)), [flag]: true }),
        },
      },
    );
    assert.ok(result.entries.some((e) => e.account.username === "known"));
    assert.ok(!result.entries.some((e) => e.account.username === "partial-user"));
    assert.ok(result.warnings.includes("system-accounts-unavailable"));
  }
  const legacy = gitManagementDetectionSchema.parse({
    binaryPath: null,
    accounts: [],
    privateKeyPaths: ["/fixture/.ssh/id_ed25519"],
    sshDirectory: "/fixture/.ssh",
    warnings: [],
  });
  assert.deepEqual(legacy.sshKeys, []);
});

test("SSH key details hash only valid public blobs; missing/corrupt/oversized public files stay unavailable", async () => {
  const { home, put } = await fixture();
  const type = Buffer.from("ssh-ed25519");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(type.length);
  const keySize = Buffer.alloc(4);
  keySize.writeUInt32BE(32);
  const blob = Buffer.concat([size, type, keySize, Buffer.alloc(32, 7)]);
  const pub = `ssh-ed25519 ${blob.toString("base64")} fixture@example.invalid`;
  for (const name of ["id_ed25519", "id_missing", "id_invalid", "id_large"])
    await put(`.ssh/${name}`, "private-fixture-never-read");
  await put(".ssh/id_ed25519.pub", pub);
  await put(".ssh/id_invalid.pub", "ssh-rsa " + blob.toString("base64"));
  await put(".ssh/id_large.pub", "x".repeat(17000));
  const result = await detectGitAccounts(home);
  assert.equal(result.sshKeys.length, 4);
  const key = result.sshKeys.find((k) => k.privateKeyPath.endsWith("id_ed25519"))!;
  assert.equal(key.keyType, "ssh-ed25519");
  assert.equal(
    key.fingerprint,
    "SHA256:" +
      createHash("sha256").update(blob).digest("base64url").replace(/-/g, "+").replace(/_/g, "/"),
  );
  assert.equal(key.publicKey, pub);
  assert.ok(
    result.sshKeys
      .filter((k) => k !== key)
      .every((k) => k.publicKey === null && k.fingerprint === null),
  );
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});
