import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./project-memory-extraction.test-support.js";
import { retryMemoryExtraction } from "./project-memory-extraction-retry.js";

test("explicit retry checks disabled and remote admission before initializing memory storage", async () => {
  for (const reason of ["disabled", "remote-disabled"]) {
    const h = harness();
    h.runtime.loadProjectMemoryRoot = async () => {
      throw new Error("Admission must precede storage IO");
    };
    if (reason === "disabled") h.runtime.config.memory!.extractionEnabled = false;
    else h.runtime.isRemoteWorkspace = () => true;
    await retryMemoryExtraction.call(h.runtime, {
      startMessageId: "user",
      boundaryMessageId: "assistant",
      turnId: "turn_fixture",
    });
    assert.equal(h.requests.length, 0);
  }
});

test("automatic extraction captures no foreground provider transcript, tools or read-file map", async () => {
  const h = harness();
  h.runtime.getTools = () => {
    throw new Error("Must not capture foreground tools");
  };
  h.runtime.messageHistory.borrowReadOnlyRuntimeEntries = () => {
    throw new Error("Must not retain provider history");
  };
  h.runtime.readFileState = new Proxy(new Map(), {
    get() {
      throw new Error("Must not copy foreground read-file state");
    },
  });
  h.schedule();
  await h.drain();
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
});
