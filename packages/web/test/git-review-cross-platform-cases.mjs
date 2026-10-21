import { showReviewFiles, returnToReview } from "./git-review-pane-helpers.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { tsImport } from "tsx/esm/api";

export async function runGitReviewCrossPlatformCases(t, { browser, url }) {
  await t.test("桌面与手机共用实际 Host：草稿、范围、审核阶段和重连恢复贯通", async () => {
    const { GitReviewWorkspaceState } = await tsImport(
      new URL("../../services/src/git/gitReviewWorkspaceState.ts", import.meta.url).href,
      import.meta.url,
    );
    const dir = await mkdtemp(join(tmpdir(), "review-browser-"));
    const host = new GitReviewWorkspaceState(dir);
    let activeScope;
    const commands = [];
    const initializers = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      try {
        const route = new URL(request.url, "http://fixture");
        if (route.pathname === "/subscribe") {
          response.setHeader("Content-Type", "text/event-stream");
          response.flushHeaders();
          const subscription = host.subscribe(JSON.parse(route.searchParams.get("scope")))(
            (snapshot) => response.write(`data: ${JSON.stringify(snapshot)}\n\n`),
          );
          request.on("close", () => subscription.dispose());
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        // 将双端同值默认初始化放在同一版本，确定性覆盖旧实现的自造冲突。
        // 修复后无需发送同值初始化；该屏障不涉及人工编辑或真实业务执行。
        if (
          route.pathname === "/update" &&
          input.patch.includeUnstaged === true &&
          input.expectedFieldRevisions.includeUnstaged === 0
        ) {
          await new Promise((resolve) => {
            initializers.push(resolve);
            if (initializers.length === 2) initializers.splice(0).forEach((release) => release());
          });
        }
        // 同一页面分别读取 epoch 来源草稿和会话合并状态；不能拿最后一次 read 当作草稿 owner。
        if (route.pathname === "/update" && Object.hasOwn(input.patch, "draft"))
          activeScope = input.scope;
        const result =
          route.pathname === "/read" ? await host.read(input) : await host.update(input);
        if (route.pathname === "/update") commands.push({ input, result });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const hostUrl = `http://127.0.0.1:${server.address().port}`;
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const fixtureUrl = `${url}?sharedHost=${encodeURIComponent(hostUrl)}`;
    const input = (page) => page.getByTestId("git-commit-message-input");
    const waitMessage = async (page, message) => {
      try {
        await page.waitForFunction(
          (message) =>
            document.querySelector('[data-testid="git-commit-message-input"]')?.value === message,
          message,
        );
      } catch (error) {
        const clients = await Promise.all(
          [desktop, phone].map((client) =>
            client.evaluate(() => ({
              draft: document.querySelector('[data-testid="git-commit-message-input"]')?.value,
              sync: document.querySelector('[data-testid="review-sync-status"]')?.textContent,
            })),
          ),
        );
        process.stderr.write(
          JSON.stringify({
            sharedHostFailure: message,
            clients,
            commands,
            host: activeScope ? await host.read(activeScope) : null,
          }) + "\n",
        );
        throw error;
      }
    };
    try {
      await Promise.all([desktop.goto(fixtureUrl), phone.goto(fixtureUrl + "&english")]);
      await desktop.getByTestId("git-action-trigger").click();
      await phone.getByTestId("git-action-trigger").click();
      await input(desktop).fill("fix: shared desktop draft");
      await waitMessage(phone, "fix: shared desktop draft");
      await input(phone).fill("fix: shared phone draft");
      await waitMessage(desktop, "fix: shared phone draft");
      const shared = await host.read(activeScope);
      assert.equal(
        shared.fieldRevisions.includeUnstaged,
        0,
        "opening with the Host default must be read-only",
      );
      await host.update({
        scope: activeScope,
        commandId: "scope-selection",
        expectedFieldRevisions: { selectedPaths: shared.fieldRevisions.selectedPaths },
        patch: { selectedPaths: ["a.ts"] },
      });
      await phone.waitForFunction(() =>
        document
          .querySelector('[data-testid="git-commit-scope-counts"]')
          ?.textContent?.includes("/ 1 files"),
      );
      await showReviewFiles(desktop, true);
      await desktop.getByTestId("git-review-include-a.ts").first().uncheck();
      await phone.waitForFunction(() =>
        document
          .querySelector('[data-testid="git-commit-scope-counts"]')
          ?.textContent?.includes("1 excluded"),
      );
      assert.equal(await desktop.getByTestId("git-commit-review-pane").isVisible(), true);
      await returnToReview(desktop);
      await phone.reload();
      await phone.getByTestId("git-action-trigger").click();
      await waitMessage(phone, "fix: shared phone draft");
      assert.match(await phone.getByTestId("git-commit-scope-counts").innerText(), /1 excluded/);
      await showReviewFiles(phone, true);
      await phone.getByTestId("review-restore-all").click();
      await desktop.waitForFunction(() =>
        document
          .querySelector('[data-testid="git-commit-scope-counts"]')
          ?.textContent?.includes("已排除 0"),
      );
      for (const page of [desktop, phone]) {
        assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), 0);
        assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls.length), 0);
      }

      const generationScope = activeScope;
      const references = [];
      const observing = host.subscribe(generationScope)((snapshot) =>
        references.push(snapshot.data.sourceReview?.id),
      );
      try {
        await desktop.evaluate(() => globalThis.__gitCommitFixture.holdGeneration());
        await desktop.getByTestId("git-commit-generate-button").click();
        await desktop.waitForFunction(() => globalThis.__gitCommitFixture.calls.length === 1);
        await phone.goto("about:blank");
        const current = await host.read(generationScope);
        const updated = await host.update({
          scope: generationScope,
          commandId: "newer-phone-review",
          expectedFieldRevisions: { sourceReview: current.fieldRevisions.sourceReview },
          patch: { sourceReview: { id: "newer-phone-review" } },
        });
        // fixture 的冻结审核事实未跨进程共享，因此该引用会明确过期；旧生成也不能覆盖更新的版本。
        await new Promise((resolve) => {
          const expired = host.subscribe(generationScope)((snapshot) => {
            if (
              !snapshot.data.sourceReview &&
              snapshot.fieldRevisions.sourceReview > updated.commandRevision
            ) {
              expired.dispose();
              resolve();
            }
          });
        });
        await desktop.evaluate(() => globalThis.__gitCommitFixture.release());
        await desktop.waitForFunction(
          () => !document.querySelector('[data-testid="git-commit-generate-button"]').disabled,
        );
        assert.equal(
          references.includes("review-1"),
          false,
          "another device's newer review must reject late model response",
        );
      } finally {
        observing.dispose();
      }

      // 双端读取同一审核事实，只同步编辑/浏览状态，阶段切换不能重放 Git 操作。
      const worktreeUrl = new URL("worktree-ui.html", url);
      worktreeUrl.searchParams.set("scenario", "review");
      worktreeUrl.searchParams.set("seedReview", "1");
      worktreeUrl.searchParams.set("sharedHost", hostUrl);
      await desktop.goto(worktreeUrl.href);
      await desktop.getByTestId("worktree-approve-candidate").waitFor();
      await desktop.waitForFunction(
        () => !document.querySelector('[data-testid="worktree-approve-candidate"]').disabled,
      );
      worktreeUrl.searchParams.set("english", "1");
      await phone.goto(worktreeUrl.href);
      await phone.getByTestId("worktree-approve-candidate").waitFor();
      await desktop.getByTestId("worktree-stage-back").click();
      await phone.getByTestId("worktree-current-stage").waitFor();
      assert.equal(await phone.getByTestId("worktree-integrate").isDisabled(), true);
      await phone.getByTestId("worktree-current-stage").click();
      await desktop.getByTestId("worktree-approve-candidate").waitFor();
      await phone.getByTestId("worktree-approve-candidate").check();
      assert.equal(
        await desktop.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
        "unchecked",
      );
      await desktop.getByTestId("worktree-stage-back").click();
      await phone.getByTestId("worktree-current-stage").waitFor();
      await phone.reload();
      await phone.getByTestId("worktree-current-stage").waitFor();
      await desktop.getByTestId("worktree-current-stage").click();
      await phone.getByTestId("worktree-approve-candidate").waitFor();
      for (const page of [desktop, phone])
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.__worktreeFixture.calls.filter((call) =>
                ["integrate", "continue", "publish", "push"].includes(call.method),
              ).length,
          ),
          0,
        );
    } finally {
      await desktop.close();
      await phone.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
