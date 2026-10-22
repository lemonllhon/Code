import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolArtifactUri,
  isToolArtifactUri,
  parseToolArtifactUri,
} from "./tool-artifact-uri.js";

test("artifact URI writes are canonical and both historical schemes decode the same IDs", () => {
  const current = createToolArtifactUri("session-中文", "result-1");
  const legacy = current.replace("lcode-artifact:", "zcode-artifact:");
  for (const uri of [current, legacy]) {
    assert.equal(isToolArtifactUri(uri), true);
    assert.deepEqual(parseToolArtifactUri(uri), {
      sessionId: "session-中文",
      artifactId: "result-1",
    });
  }
  for (const uri of [
    "zcode-artifact://s/..",
    "lcode-artifact://s/%2fescape",
    "lcode-artifact://s/a/b",
    "lcode-artifact://s/%00",
    "lcode-artifact://s/%GG",
    "lcode-artifact://s/a?b",
  ]) {
    assert.throws(() => parseToolArtifactUri(uri), /Invalid tool artifact URI/);
  }
  assert.equal(isToolArtifactUri("https://example.invalid/a"), false);
  assert.throws(
    () => parseToolArtifactUri("https://example.invalid/a"),
    /Unsupported tool artifact URI/,
  );
});
