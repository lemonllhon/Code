import assert from "node:assert/strict";
import test from "node:test";
import { ProjectMemoryRecallIndex } from "./index.js";
import { createRecallHarness } from "./recall.test-support.js";

test("labeled synthetic task queries retrieve relevant facts without filling zero-match slots", async () => {
  const harness = createRecallHarness(
    new Map([
      [
        "/memory/release.md",
        {
          content:
            "---\ntype: reference\ndescription: 发布规则\n---\nrelease_tag 发布前需要独立审核。",
          mtimeMs: 1,
        },
      ],
      [
        "/memory/layout.md",
        {
          content: "---\ntype: user\n---\nbutton_spacing 按钮间距使用八像素。不要修改账号鉴权。",
          mtimeMs: 1,
        },
      ],
      [
        "/memory/plain.md",
        { content: "本地 plain_directory 没有仓库，正常编辑文件，无需初始化。", mtimeMs: 1 },
      ],
      ["/memory/network.md", { content: "fetch_failure 必须披露失败退出码。", mtimeMs: 1 }],
      ["/memory/noise.md", { content: "Java spring hello tutorial", mtimeMs: 1 }],
    ]),
  );
  const index = new ProjectMemoryRecallIndex();
  for (const [query, expected] of [
    ["release_tag", "release.md"],
    ["button_spacing", "layout.md"],
    ["plain_directory", "plain.md"],
    ["fetch_failure", "network.md"],
  ]) {
    const result = await index.recall({
      fileSystem: harness.fileSystem,
      rootDir: "/memory",
      query: query!,
    });
    assert.deepEqual(
      result.results.map((entry) => entry.filename),
      [expected],
    );
  }
  assert.equal(
    (
      await index.recall({
        fileSystem: harness.fileSystem,
        rootDir: "/memory",
        query: "zzzx_no_evidence",
      })
    ).attachment,
    undefined,
  );
});
