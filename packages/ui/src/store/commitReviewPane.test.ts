import assert from "node:assert/strict";
import test from "node:test";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore,
} from "./commitReviewNavigationStore.js";

test("审核导航按原项目身份和会话隔离；重复打开为激活；旧清理不能删除新注册", () => {
  const store = useCommitReviewNavigationStore.getState();
  const key = commitReviewNavigationKey("/repo", "host-a/repo", "a");
  let opens = 0;
  store.registerPaneNavigation(key, {
    token: "old",
    open: () => opens++,
    close() {},
    selectView() {},
  });
  store.registerPaneNavigation(key, {
    token: "new",
    open: () => opens++,
    close() {},
    selectView() {},
  });
  store.removePaneNavigation(key, "old");
  assert.equal(store.revealPane(commitReviewNavigationKey("/repo", "host-b/repo", "a")), false);
  assert.equal(store.revealPane(commitReviewNavigationKey("/repo", "host-a/repo", "b")), false);
  assert.equal(store.revealPane(key), true);
  assert.equal(store.revealPane(key), true);
  assert.equal(opens, 2);
  store.removePaneNavigation(key, "new");
  assert.equal(store.revealPane(key), false);
});

test("隐藏插槽不表示 shown，旧 token 不能释放新 scope 的插槽", () => {
  const store = useCommitReviewNavigationStore.getState();
  const key = commitReviewNavigationKey("/repo", undefined, "a");
  const element = {} as HTMLElement;
  store.registerPaneHost(key, { token: "old", element, visible: true });
  store.registerPaneHost(key, { token: "new", element, visible: false });
  store.removePaneHost(key, "old");
  assert.equal(useCommitReviewNavigationStore.getState().paneHosts[key]?.visible, false);
  store.setPaneHostVisible(key, "old", true);
  assert.equal(useCommitReviewNavigationStore.getState().paneHosts[key]?.visible, false);
  store.setPaneHostVisible(key, "new", true);
  assert.equal(useCommitReviewNavigationStore.getState().paneHosts[key]?.visible, true);
  assert.equal(
    useCommitReviewNavigationStore.getState().paneHosts[key]?.element,
    element,
    "切工具只改可见投影，保持原 DOM 插槽",
  );
  store.removePaneHost(key, "new");
  assert.equal(useCommitReviewNavigationStore.getState().paneHosts[key], undefined);
});

test("主窗口导航卸载后，独立审核仍通过原会话插槽切换子页", () => {
  const store = useCommitReviewNavigationStore.getState();
  const key = commitReviewNavigationKey("/repo", "remote-a", "a");
  const other = commitReviewNavigationKey("/repo", "remote-b", "a");
  const views: string[] = [];
  store.registerPaneHost(key, {
    token: "native",
    element: {} as HTMLElement,
    visible: true,
    selectView: (view) => views.push(view),
  });
  assert.equal(store.revealPane(other), false);
  assert.equal(store.revealPane(key), true);
  store.selectPaneView(key, "changes");
  store.selectPaneView(other, "network");
  assert.deepEqual(views, ["review", "changes"]);
  store.removePaneHost(key, "native");
  assert.equal(store.revealPane(key), false);
});
