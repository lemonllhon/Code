import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialService } from "../credential/credentialService.js";
import { getDataBaseDir, setDataBaseDir } from "../paths.js";
import { createGitManagementService } from "./gitManagementService.js";
test("Actual credential persistence encrypts Git tokens, survives restart and refuses corrupt storage", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-git-vault-")),
    previous = getDataBaseDir();
  setDataBaseDir(home);
  t.after(() => setDataBaseDir(previous));
  const create = () =>
    createGitManagementService({
      credentials: createCredentialService(),
      home,
      lockPath: join(home, "profile"),
    });
  const first = create(),
    snapshot = await first.mutate({
      type: "save",
      expectedRevision: "empty",
      account: {
        name: "Private fixture",
        provider: "gitlab",
        serverUrl: "https://gitlab.example.invalid",
        username: "fixture",
        auth: "token",
        privateKeyPath: "",
        token: "fixture-encrypted-token",
      },
    });
  const file = join(home, ".lcode", "v2", "credentials.json"),
    raw = await readFile(file, "utf8");
  assert.ok(!raw.includes("fixture-encrypted-token"));
  assert.ok(!raw.includes("Private fixture"));
  assert.ok(raw.includes("enc:lcode:v2:"));
  const restarted = create();
  assert.deepEqual(await restarted.getSnapshot(), snapshot);
  assert.equal(
    (
      await restarted.authentication("https://gitlab.example.invalid/o/r.git", {
        id: snapshot.accounts[0]!.id,
      })
    ).secret,
    "fixture-encrypted-token",
  );
  await writeFile(file, "{ corrupt fixture");
  await assert.rejects(restarted.getSnapshot(), /corrupt|损坏/);
  await assert.rejects(
    restarted.mutate({
      type: "delete",
      expectedRevision: snapshot.revision,
      id: snapshot.accounts[0]!.id,
    }),
    /corrupt|损坏/,
  );
  assert.equal(await readFile(file, "utf8"), "{ corrupt fixture");
});
