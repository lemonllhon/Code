import assert from "node:assert/strict";
import test from "node:test";
import { TerminalOutputFlow } from "./terminalOutputFlow.js";

test("PTY pressure follows consumed characters, keeps original chunks and fences old consumers", () => {
  const events: string[] = [];
  const owner = new TerminalOutputFlow(
    () => events.push("pause"),
    () => events.push("resume"),
  );
  owner.start();
  const first = owner.frame("a".repeat(48 * 1024));
  const second = owner.frame("b".repeat(24 * 1024));
  assert.equal(first.data.length + second.data.length, 72 * 1024);
  assert.deepEqual(events, ["pause"]);
  owner.acknowledge(second.flow!.leaseId, second.flow!.offset + 1);
  owner.acknowledge(first.flow!.leaseId, first.flow!.offset);
  assert.deepEqual(events, ["pause"]);
  owner.acknowledge(second.flow!.leaseId, second.flow!.offset);
  assert.deepEqual(events, ["pause", "resume"]);
  owner.acknowledge(first.flow!.leaseId, first.flow!.offset);
  assert.equal(owner.diagnostics.pendingChars, 0);
  owner.start();
  const current = owner.frame("c".repeat(64 * 1024));
  owner.acknowledge(second.flow!.leaseId, second.flow!.offset);
  assert.equal(owner.diagnostics.paused, 1);
  owner.acknowledge(current.flow!.leaseId, current.flow!.offset);
  assert.equal(owner.diagnostics.paused, 0);
});

test("last consumer release resumes a paused PTY; physical exit does not resume dead processes", () => {
  let resumed = 0;
  const owner = new TerminalOutputFlow(
    () => {},
    () => resumed++,
  );
  owner.start();
  owner.frame("a".repeat(64 * 1024));
  owner.stop();
  owner.stop();
  assert.equal(resumed, 1);
  assert.deepEqual(owner.frame("tail"), { data: "tail" });
  owner.start();
  owner.frame("b".repeat(64 * 1024));
  owner.stop(false);
  assert.equal(resumed, 1);
  assert.deepEqual(owner.diagnostics, { paused: 0, pendingChars: 0 });
});

test("synchronous native resume output can immediately apply pressure again", () => {
  let pauses = 0;
  const owner = new TerminalOutputFlow(
    () => pauses++,
    () => {
      owner.frame("b".repeat(64 * 1024));
    },
  );
  owner.start();
  const first = owner.frame("a".repeat(64 * 1024));
  owner.acknowledge(first.flow!.leaseId, first.flow!.offset);
  assert.equal(pauses, 2);
  assert.equal(owner.diagnostics.paused, 1);
});
