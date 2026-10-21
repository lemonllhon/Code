import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { historyFixture } from "./gitHistoryTestHelpers.js";
const exec = promisify(execFile);

test("附注 Tag 预览零写入，配置变化/占用名拒绝，不自动 Push，同 requestId 不再创建", async (t) => {
  const f = await historyFixture(t),
    hash = (await f.git("rev-parse", "HEAD")).trim();
  const options = {
    ...f.scope,
    hash,
    name: "release/测试",
    message: "版本注释\n第二行",
    signed: false,
  };
  const preview = await f.service.previewHistoryTag(options);
  assert.equal((await f.service.getHistoryTag({ ...f.scope, name: options.name })).oid, null);
  await f.git("config", "user.name", "Changed");
  assert.equal(
    (await f.service.createHistoryTag({ ...f.scope, requestId: "stale", preview })).code,
    "stale-preview",
  );
  const current = await f.service.previewHistoryTag(options),
    command = { ...f.scope, requestId: "tag", preview: current };
  assert.equal((await f.service.createHistoryTag(command)).status, "success");
  const info = await f.service.getHistoryTag({ ...f.scope, name: options.name });
  assert.equal(info.target, hash);
  assert.equal(info.hasSignature, false);
  assert.match(info.message!, /第二行/);
  assert.equal((await f.service.createHistoryTag(command)).tagOid, info.oid);
  await assert.rejects(f.service.previewHistoryTag(options), /tag-exists/);
  assert.equal((await f.git("branch", "--show-current")).trim(), "main");
  const permit = await f.coordinator.acquire({
    workspacePath: f.root,
    ownerId: "agent",
    mode: "shared",
    waitMs: 0,
  });
  try {
    const p = await f.service.previewHistoryTag({ ...options, name: "while-agent" });
    assert.equal(
      (await f.service.createHistoryTag({ ...f.scope, requestId: "tag-agent", preview: p })).status,
      "success",
    );
  } finally {
    await f.coordinator.release(permit);
  }
});

test("真实 SSH 签名使用临时密钥并由 Git 验证；缺少配置明确拒绝", async (t) => {
  const f = await historyFixture(t),
    hash = (await f.git("rev-parse", "HEAD")).trim();
  const options = { ...f.scope, hash, name: "signed", message: "signed fixture", signed: true };
  await assert.rejects(f.service.previewHistoryTag(options), /signer-not-configured/);
  const candidate = resolve(
    (await f.git("--exec-path")).trim(),
    "../../../usr/bin/ssh-keygen" + (process.platform === "win32" ? ".exe" : ""),
  );
  const keygen = await access(candidate).then(
      () => candidate,
      () => "ssh-keygen",
    ),
    key = join(f.base, "fixture-signing-key");
  await exec(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", key], { windowsHide: true });
  await f.git("config", "gpg.format", "ssh");
  await f.git("config", "user.signingkey", key);
  await f.git("config", "gpg.ssh.program", keygen);
  const allowed = join(f.base, "allowed-signers");
  await writeFile(allowed, "fixture@example.invalid " + (await readFile(key + ".pub", "utf8")));
  await f.git("config", "gpg.ssh.allowedSignersFile", allowed);
  const preview = await f.service.previewHistoryTag(options),
    result = await f.service.createHistoryTag({ ...f.scope, requestId: "sign", preview });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal((await f.service.getHistoryTag({ ...f.scope, name: "signed" })).hasSignature, true);
  await f.git("verify-tag", "signed");
});

test("Tag 已创建但回执超时保持 unknown，查询原收据/实际 Tag，不重复签名或删除", async (t) => {
  let count = 0;
  const f = await historyFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (params.args.includes("--annotate")) {
        count++;
        return { ...result, timedOut: true };
      }
      return result;
    },
  }));
  const preview = await f.service.previewHistoryTag({
      ...f.scope,
      hash: (await f.git("rev-parse", "HEAD")).trim(),
      name: "unknown",
      message: "retained",
      signed: false,
    }),
    command = { ...f.scope, requestId: "tag", preview };
  assert.equal((await f.service.createHistoryTag(command)).status, "unknown");
  assert.equal((await f.service.createHistoryTag(command)).status, "unknown");
  assert.equal(count, 1);
  assert.ok((await f.service.getHistoryTag({ ...f.scope, name: "unknown" })).oid);
});

test("未确认 Tag 原生进程退出时保留 repository lease；另一仓库写入不能借新 request 绕过", async (t) => {
  const f = await historyFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      return params.args.includes("--annotate") ? { ...result, orphaned: true } : result;
    },
  }));
  const preview = await f.service.previewHistoryTag({
    ...f.scope,
    hash: (await f.git("rev-parse", "HEAD")).trim(),
    name: "orphan-tag",
    message: "kept",
    signed: false,
  });
  assert.equal(
    (await f.service.createHistoryTag({ ...f.scope, requestId: "tag", preview })).unsettled,
    true,
  );
  assert.ok((await f.service.getHistoryTag({ ...f.scope, name: "orphan-tag" })).oid);
  await assert.rejects(
    f.service.mutateRemote({
      ...f.scope,
      requestId: "other",
      expectedRevision: "a".repeat(64),
      action: "add",
      name: "unused",
      fetchUrls: ["/fixture/remote"],
    }),
    { code: "LCODE_CHECKOUT_BUSY" },
  );
});
