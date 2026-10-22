import assert from "node:assert/strict";
import test from "node:test";
import type {
  FilePart,
  MessageId,
  PartId,
  SessionId,
  ToolArtifactStorePort,
} from "@lcode/contracts";
import { filePartToContentBlock } from "./file-part-hydration.js";
import { projectMessagesWithMediaAttachmentPaths } from "../runtime/helpers/media-attachment-path.js";

test("historical artifact file parts hydrate model media and materialize through the artifact owner", async () => {
  const uri = "zcode-artifact://fixture/result";
  const dataUrl = "data:image/png;base64,ZmFrZQ==";
  const reads: string[] = [];
  const store: ToolArtifactStorePort = {
    writeToolResultArtifact: async () => {
      throw new Error("read compatibility must not rewrite storage");
    },
    readToolResultArtifact: async ({ uri }) => {
      reads.push(uri);
      return {
        uri,
        path: "artifact",
        content: dataUrl,
        bytes: dataUrl.length,
        contentType: "text/plain",
      };
    },
    ensureMediaAttachmentPath: async ({ uri }) => {
      reads.push(uri);
      return { status: "ready", path: "fixture.png", mediaType: "image/png" };
    },
  };
  const part: FilePart = {
    id: "part" as PartId,
    sessionID: "fixture" as SessionId,
    messageID: "message" as MessageId,
    type: "file",
    mime: "image/png",
    url: uri,
    source: { type: "file", path: "deleted.png", text: { value: "image", start: 0, end: 5 } },
  };
  const block = await filePartToContentBlock(part, store);
  assert.equal(block.type, "image");
  const messages = await projectMessagesWithMediaAttachmentPaths(
    [{ role: "user", content: [block] }],
    store,
  );
  assert.deepEqual(reads, [uri, uri]);
  assert.equal(block.source?.kind, "inline");
  assert.match(JSON.stringify(messages), /fixture\.png/);
});
