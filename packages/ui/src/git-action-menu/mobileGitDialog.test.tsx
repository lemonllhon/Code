import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const commitDialog = await readFile(new URL("./GitCommitReviewPane.tsx", import.meta.url), "utf8");
const feedback = await readFile(new URL("./GitPublishFeedback.tsx", import.meta.url), "utf8");
const reviewPanel = await readFile(new URL("./GitCommitReviewPanel.tsx", import.meta.url), "utf8");
const controller = await readFile(new URL("../GitActionMenu.tsx", import.meta.url), "utf8");

// 接线回归防止重新引入审核 modal；真实宽度、交互和固定底栏由 Web 套件验证。
test("commit and publish use the same side pane without a second dialog", () => {
  assert.doesNotMatch(commitDialog, /<Dialog\b|<DialogContent\b/);
  assert.match(commitDialog, /<GitReviewFiles/);
  assert.match(commitDialog, /data-testid="git-review-scroll"/);
  assert.match(commitDialog, /<ReviewDialogFooter/);
  assert.match(commitDialog, /<GitCommitReviewPanel/);
  assert.match(commitDialog, /<GitPublishPreview/);
  assert.match(commitDialog, /<GitPublishResults/);
  assert.doesNotMatch(controller, /GitPushDialog|openPushDialog/);
});

test("publication preserves readable full errors and retries only failed pushes", () => {
  assert.match(feedback, /\[overflow-wrap:anywhere\]/);
  assert.match(feedback, /\bflex-wrap\b/);
  assert.match(feedback, /row\.message/);
  assert.match(feedback, /row\.status === "failed"/);
  assert.match(feedback, /row\.kind === "branch" \|\| row\.kind === "tag"/);
  assert.match(controller, /platform\.writeClipboardText/);
  assert.doesNotMatch(controller, /navigator\.clipboard/);
});

test("keyboard action cannot select publishing or bypass regeneration/review guards", () => {
  assert.match(commitDialog, /!reviewCanSubmit/);
  assert.match(commitDialog, /props\.requiresRegeneration/);
  assert.match(commitDialog, /!hasIdentity && state\?\.identity !== null/);
  assert.match(commitDialog, /matchesPrimaryShortcut\(event, "Enter"\)/);
  assert.match(commitDialog, /if \(!showMerge && !commitActionDisabled\) props\.onSubmit\(\)/);
  assert.doesNotMatch(commitDialog, /triggerSelectedAction/);
});

test("large frozen reviews retain confirmation while files render directly in the pane", () => {
  const acknowledge = reviewPanel.indexOf('data-testid="git-review-acknowledge"');
  const manualFallback = reviewPanel.indexOf('data-testid="git-review-manual-fallback"');
  assert.ok(acknowledge >= 0 && manualFallback >= 0);
  assert.doesNotMatch(reviewPanel, /git-review-open-files/);
  assert.doesNotMatch(reviewPanel, /data-testid="git-review-files"|<pre\b/);
});
