import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverHtmlEntries } from "./knip-html-entries.mjs";

test("Knip follows local HTML scripts without treating every fixture helper as an entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-knip-html-"));
  try {
    await mkdir(join(root, "test/fixtures"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "test/fixtures/page.html"),
      `
      <script type="module" src="./page.tsx?v=1"></script>
      <script type="module">import "/src/root.ts"; import('./inline.ts')</script>
      <script src="https://example.test/external.js"></script>
      <script type="module" src="../../../outside.ts"></script>
      <link rel="stylesheet" href="./fixture.css">
    `,
    );
    for (const file of [
      "test/fixtures/page.tsx",
      "test/fixtures/inline.ts",
      "test/fixtures/helper.tsx",
      "test/fixtures/fixture.css",
      "src/root.ts",
    ])
      await writeFile(join(root, file), "export {};\n");
    assert.deepEqual(await discoverHtmlEntries(root, ["test/fixtures"]), [
      "src/root.ts",
      "test/fixtures/fixture.css",
      "test/fixtures/inline.ts",
      "test/fixtures/page.tsx",
    ]);
    assert.deepEqual(await discoverHtmlEntries(root, ["missing"]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
