import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalProjectsProvider, useLocalProjectForWorkspace } from "./LocalProjectsContext.js";

test("the complete project menu registry cannot route local file mentions through a same-path remote project", () => {
  const local = {
    id: "local",
    name: "Local",
    primaryFolderPath: "/app",
    sourceFolderPaths: ["/app"],
  };
  const remote = { ...local, id: "remote", workspaceIdentity: "remote-origin" };
  function Probe({ identity }: { identity?: string }) {
    return <span>{useLocalProjectForWorkspace("/app", identity)?.id ?? "none"}</span>;
  }
  const view = renderToStaticMarkup(
    <LocalProjectsProvider projects={[remote, local]}>
      <Probe />
      <Probe identity="remote-origin" />
    </LocalProjectsProvider>,
  );
  assert.equal(view, "<span>local</span><span>none</span>");
});
