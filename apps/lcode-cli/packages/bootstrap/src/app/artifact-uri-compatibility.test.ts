import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeToolArtifactStore } from "@lcode/adapters/storage";
import {
  createTraceId,
  type FilePart,
  type MessageId,
  type PartId,
  type SessionId,
  type MessageWithParts,
} from "@lcode/contracts";
import {
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
  decodeMarkdownArtifactImageSource,
} from "@lcode/shared";
import { createAppAttachmentReadFacade } from "./app-attachment-facade.js";
import { mapSnapshotMessages } from "../lcode-protocol/session-snapshot-messages.js";
import { ConversationTopicPublisher } from "../lcode-protocol-v4/conversation-topic-publisher.js";
import { synthesizeEventsFromMessages } from "../lcode-protocol-v4/transcript-hydration.js";
import { resolveReadableMediaAttachment } from "../lcode-protocol-v4/v4-gateway-attachment-authorization.js";

test("legacy artifact reads, stats, snapshots and Markdown retain session authorization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createNodeToolArtifactStore({
    rootDir: join(root, "artifacts"),
    imageCacheRootDir: join(root, "images"),
    videoCacheRootDir: join(root, "videos"),
  });
  const sessionId = "fixture" as SessionId;
  const content = "data:image/png;base64,ZmFrZQ==";
  const saved = await store.writeToolResultArtifact({
    sessionId,
    toolCallId: "call",
    toolName: "fixture",
    content,
    contentType: "text/plain",
  });
  const uri = saved.uri.replace("lcode-artifact:", "zcode-artifact:");
  const part: FilePart = {
    id: "part" as PartId,
    sessionID: sessionId,
    messageID: "message" as MessageId,
    type: "file",
    mime: "image/png",
    url: uri,
  };
  const message: MessageWithParts = {
    info: {
      id: part.messageID,
      sessionID: sessionId,
      role: "user",
      agent: "fixture",
      time: { created: 1 },
    },
    parts: [part],
  };
  const facade = createAppAttachmentReadFacade({
    sessionId,
    traceContext: { traceId: createTraceId() },
    artifactStore: store,
    sessionStore: { messageWithParts: async () => message },
    fileSystemPort: {
      readBinaryFile: async () => {
        throw new Error("artifact must not reach filesystem path API");
      },
      stat: async () => {
        throw new Error("artifact stat must not reach filesystem path API");
      },
    },
  });
  assert.ok(facade.statPromptAttachment);
  for (const input of [
    { ref: uri, mime: "image/png", maxBytes: 100 },
    {
      ref: "deleted.png",
      mime: "image/png",
      maxBytes: 100,
      messageId: "message",
      attachmentIndex: 0,
    },
  ]) {
    assert.equal(Buffer.from((await facade.readPromptAttachment(input)).bytes).toString(), "fake");
    assert.equal((await facade.statPromptAttachment(input)).totalBytes, saved.bytes);
  }
  const mapped = await mapSnapshotMessages(facade, [message]);
  const mappedPart = mapped[0]?.parts[0];
  assert.ok(mappedPart?.type === "file");
  assert.equal(mappedPart.url, content);
  const markdown = `![fixture](${uri})`;
  assert.deepEqual(extractMarkdownArtifactImageRefs(markdown), [uri]);
  const rewritten = rewriteMarkdownArtifactImageSources(markdown);
  assert.equal(decodeMarkdownArtifactImageSource(rewritten.slice("![fixture](".length, -1)), uri);
  // 权威历史中即使出现另一个 session 的 Markdown 引用，也不能跨会话授权。
  const assistant = {
    info: {
      ...message.info,
      id: "assistant",
      role: "assistant",
      parentID: part.messageID,
      time: { created: 2 },
    },
    parts: [{ type: "text", id: "answer", text: markdown }],
  } as unknown as MessageWithParts;
  const publisher = new ConversationTopicPublisher(sessionId, "epoch");
  publisher.rehydrate(
    synthesizeEventsFromMessages(
      [
        {
          ...message,
          parts: [
            {
              type: "text",
              id: "input" as PartId,
              sessionID: sessionId,
              messageID: part.messageID,
              text: "fixture",
            },
          ],
        },
        assistant,
      ],
      { sessionId },
    ),
  );
  assert.ok(resolveReadableMediaAttachment(publisher, sessionId, uri));
  assert.equal(resolveReadableMediaAttachment(publisher, "other-session", uri), null);
});
