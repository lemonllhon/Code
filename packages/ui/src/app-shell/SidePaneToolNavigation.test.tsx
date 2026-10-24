import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePaneToolNavigation } from "./SidePaneToolNavigation.js";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import type { WorkspaceSidePaneTab } from "../lib/workspaceSidePane.js";

test("提交审核只显示有内容的工具，不展示灰色入口", () => {
  const html = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <SidePaneToolNavigation
        tabs={[{ id: "git", type: "git" }]}
        activeTabId="git"
        onActivate={() => {}}
      />
    </LCodeIntlProvider>,
  );
  assert.match(html, /side-pane-tool-git/);
  for (const id of ["files", "browser", "terminal", "more"])
    assert.doesNotMatch(html, new RegExp(`side-pane-tool-${id}`));
  assert.doesNotMatch(html, / disabled=/);
});

test("有内容的工具仍提供切换入口", () => {
  const tabs = [
    { id: "git", type: "git" },
    { id: "terminal:one", type: "terminal" },
  ] as WorkspaceSidePaneTab[];
  const html = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <SidePaneToolNavigation tabs={tabs} activeTabId="git" onActivate={() => {}} />
    </LCodeIntlProvider>,
  );
  assert.match(html, /side-pane-tool-git/);
  assert.match(html, /side-pane-tool-terminal/);
  assert.doesNotMatch(html, / disabled=/);
});
