import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { readFile, writeFile, symlink, mkdir, access, unlink } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";

async function fixture(
  t: TestContext,
  versions: { stage: number; bytes: Buffer; mode?: string }[],
  result: Buffer,
  wrap?: Parameters<typeof publishFixture>[1],
  name = "a.txt",
) {
  const f = await publishFixture(t, wrap);
  const command = f.command,
    coordinator = createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: command });
  const options = {
      commandProvider: command,
      checkoutCoordinator: coordinator,
      reviewStateDataDir: join(f.base, "receipts"),
    },
    service = coordinateGitCheckoutWrites(createGitService(options), coordinator),
    scope = f.request;
  let input = `0 ${"0".repeat(40)}\t${name}\n`;
  for (const version of versions) {
    const path = join(f.base, `blob-${version.stage}`);
    await writeFile(path, version.bytes);
    const oid = (
      await f.git(
        ...(version.mode === "160000"
          ? ["rev-parse", "HEAD"]
          : ["hash-object", "-w", "--no-filters", path]),
      )
    ).trim();
    input += `${version.mode ?? "100644"} ${oid} ${version.stage}\t${name}\n`;
  }
  const native = await command.run({
    cwd: f.root,
    args: ["update-index", "--index-info"],
    stdin: input,
  });
  assert.equal(native.exitCode, 0);
  await writeFile(join(f.root, name), result);
  const snapshot = await service.getConflictSnapshot(scope);
  assert.equal(
    (
      await service.beginConflictResolution({
        ...scope,
        requestId: "begin",
        expectedRevision: snapshot.revision,
      })
    ).status,
    "conflict",
  );
  const intent = async (requestId: string) => ({
    ...scope,
    requestId,
    sourceRequestId: "begin",
    path: name,
    expectedRevision: (await service.getConflictFile({ ...scope, path: name })).revision,
    confirmNativeStopped: false,
  });
  return { ...f, name, service, scope, coordinator, options, intent };
}
const texts = () => [1, 2, 3].map((stage) => ({ stage, bytes: Buffer.from(`stage-${stage}\n`) }));

test("临时 index 生成期间外部改写文件，拒绝发布并保留原 stages 与新文件", async (t) => {
  const f = await fixture(t, texts(), Buffer.from("reviewed\n"), (native) => ({
    ...native,
    run: async (params) => {
      const result = await native.run(params);
      if (params.env?.GIT_INDEX_FILE && params.args.includes("add"))
        await writeFile(join(params.cwd, "a.txt"), "external-after\n");
      return result;
    },
  }));
  const original = await readFile(join(f.root, ".git", "index"));
  const result = await f.service.markConflictResolved({
    ...(await f.intent("changed-during-add")),
    confirmSpecial: false,
  });
  assert.equal(result.code, "stale-conflict");
  assert.deepEqual(await readFile(join(f.root, ".git", "index")), original);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "external-after\n");
  assert.equal((await f.service.getConflictSnapshot(f.scope)).files.length, 1);
});

test("Unicode 和特殊文件名使用 literal path，目录与真实 gitlink 分流", async (t) => {
  const f = await fixture(t, texts(), Buffer.from("result\n"), undefined, "-[[] 中文].txt");
  assert.equal(
    (
      await f.service.saveConflictResult({
        ...(await f.intent("unicode-save")),
        action: "save",
        text: "保留末尾\r\n",
      })
    ).status,
    "success",
  );
  assert.equal(
    (
      await f.service.markConflictResolved({
        ...(await f.intent("unicode-mark")),
        confirmSpecial: false,
      })
    ).status,
    "success",
  );
  assert.equal(await f.git("show", `:${f.name}`), "保留末尾\r\n");
  const directory = await fixture(t, texts(), Buffer.from("result\n"));
  await unlink(join(directory.root, "a.txt"));
  await mkdir(join(directory.root, "a.txt"));
  const detail = await directory.service.getConflictFile({ ...directory.scope, path: "a.txt" });
  assert.equal(detail.result.kind, "directory");
  assert.equal(detail.canMark, false);
  const submodule = await fixture(
    t,
    texts().map((version) => ({ ...version, mode: "160000" })),
    Buffer.from("gitlink"),
  );
  const link = await submodule.service.getConflictFile({ ...submodule.scope, path: "a.txt" });
  assert.equal(link.ours.kind, "submodule");
  assert.equal(link.editable, false);
  assert.equal(link.canMark, false);
});

test("modify/delete 独立删除结果和标记，不递归、不把缺失版本当空文本", async (t) => {
  const f = await fixture(t, texts().slice(0, 2), Buffer.from("keep\n"));
  const file = await f.service.getConflictFile({ ...f.scope, path: "a.txt" });
  assert.equal(file.entry.kind, "deleted-by-them");
  assert.equal(file.theirs.kind, "absent");
  assert.equal(
    (await f.service.saveConflictResult({ ...(await f.intent("delete")), action: "delete" }))
      .status,
    "success",
  );
  await assert.rejects(access(join(f.root, "a.txt")), { code: "ENOENT" });
  assert.equal((await f.service.getConflictSnapshot(f.scope)).files.length, 1);
  assert.equal(
    (await f.service.markConflictResolved({ ...(await f.intent("mark")), confirmSpecial: false }))
      .status,
    "success",
  );
  assert.equal((await f.service.getConflictSnapshot(f.scope)).files.length, 0);
});

test("二进制、非 UTF-8、大对象、symlink 与复杂单阶段分流；外部二进制需独立确认", async (t) => {
  for (const [kind, bytes, mode, stageNumbers] of [
    ["binary", Buffer.from([0, 255, 65]), "100644", [1, 2, 3]],
    ["encoding", Buffer.from([0xff, 0xfe, 65]), "100644", [1, 2, 3]],
    ["large", Buffer.alloc(256 * 1024 + 1, 65), "100644", [1, 2, 3]],
    ["symlink", Buffer.from("elsewhere"), "120000", [1, 2, 3]],
    ["text", Buffer.from("rename\n"), "100644", [2]],
  ] as const) {
    await t.test(kind + stageNumbers.join(""), async (t) => {
      const f = await fixture(
        t,
        stageNumbers.map((stage) => ({ stage, bytes, mode })),
        bytes,
      );
      const file = await f.service.getConflictFile({ ...f.scope, path: "a.txt" });
      assert.equal(file.ours.kind, kind);
      assert.equal(file.editable, false);
      assert.equal(
        (
          await f.service.saveConflictResult({
            ...(await f.intent("save")),
            action: "save",
            text: "not bytes",
          })
        ).code,
        "unsupported-conflict",
      );
      if (file.canMark) {
        assert.equal(
          (
            await f.service.markConflictResolved({
              ...(await f.intent("unconfirmed")),
              confirmSpecial: false,
            })
          ).code,
          "unsupported-conflict",
        );
        assert.equal(
          (
            await f.service.markConflictResolved({
              ...(await f.intent("confirmed")),
              confirmSpecial: true,
            })
          ).status,
          "success",
        );
        assert.deepEqual(await readFile(join(f.root, "a.txt")), bytes);
      }
    });
  }
});

test("BOM、CRLF、空结果字节保持，冲突标记阻止标记；路径穿越和父链接拒绝", async (t) => {
  const f = await fixture(
    t,
    texts(),
    Buffer.from("<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n"),
  );
  assert.equal((await f.service.getConflictFile({ ...f.scope, path: "a.txt" })).hasMarkers, true);
  assert.equal(
    (
      await f.service.markConflictResolved({
        ...(await f.intent("markers")),
        confirmSpecial: false,
      })
    ).code,
    "unsupported-conflict",
  );
  for (const text of ["\ufeff中文\r\n最后一行", ""]) {
    const result = await f.service.saveConflictResult({
      ...(await f.intent(text ? "bom" : "empty")),
      action: "save",
      text,
    });
    assert.equal(result.status, "success");
    assert.deepEqual(await readFile(join(f.root, "a.txt")), Buffer.from(text));
  }
  for (const path of ["../a.txt", ".git/config", "C:/outside", "a/../../b"])
    await assert.rejects(f.service.getConflictFile({ ...f.scope, path }));
  const outside = join(f.base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "file.txt"), "untouched");
  await symlink(outside, join(f.root, "link"), "junction");
  const oid = (await f.git("hash-object", "-w", "--no-filters", join(outside, "file.txt"))).trim();
  await f.command.run({
    cwd: f.root,
    args: ["update-index", "--index-info"],
    stdin: [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\tlink/file.txt\n`).join(""),
  });
  await assert.rejects(
    f.service.getConflictFile({ ...f.scope, path: "link/file.txt" }),
    /Symbolic link directory/,
  );
  assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "untouched");
});

test("未结算的原生标记保留主索引、native 锁和原 owner fence；重放不重新 add", async (t) => {
  let nativeWrites = 0;
  const f = await fixture(t, texts(), Buffer.from("resolved\n"), (native) => ({
    ...native,
    run: async (params) => {
      const result = await native.run(params);
      if (params.env?.GIT_INDEX_FILE && params.args.includes("add")) {
        nativeWrites++;
        return { ...result, timedOut: true, orphaned: true };
      }
      return result;
    },
  }));
  const original = await readFile(join(f.root, ".git", "index"));
  const params = { ...(await f.intent("unknown")), confirmSpecial: false };
  const result = await f.service.markConflictResolved(params);
  assert.equal(result.status, "unknown");
  assert.equal(result.unsettled, true);
  assert.deepEqual(await f.service.markConflictResolved(params), result);
  assert.equal(nativeWrites, 1);
  assert.deepEqual(await readFile(join(f.root, ".git", "index")), original);
  await access(join(f.root, ".git", "index.lock"));
  assert.equal((await f.service.getConflictSnapshot(f.scope)).nativeCheck, true);
  await assert.rejects(
    f.coordinator.acquire({ workspacePath: f.root, ownerId: "another", mode: "shared", waitMs: 0 }),
    { code: "LCODE_CHECKOUT_BUSY" },
  );
});
