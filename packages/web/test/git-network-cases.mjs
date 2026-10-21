import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function runGitNetworkCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-network.html", url).href;
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-view-network").click();
    await page.getByRole("checkbox", { name: "选择远端 origin" }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="选择远端 origin"]').disabled,
    );
  };
  const action = (method, value) =>
    page.evaluate(({ method, value }) => globalThis.__gitNetwork[method](value), { method, value });
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitNetwork.calls.filter(
        (call) => !["snapshot", "receipt", "preview"].includes(call.method),
      ),
    );
  const settle = async (count = 1) => {
    await page.waitForFunction(
      (count) =>
        globalThis.__gitNetwork.calls.filter(
          (call) => !["snapshot", "receipt", "preview"].includes(call.method),
        ).length === count,
      count,
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-network-update"]').disabled,
    );
  };
  await t.test("右侧远端入口与刷新保持离线；Fetch 独立选择，部分成功逐项显示", async () => {
    await go();
    assert.deepEqual(await writes(), []);
    assert.equal(await page.getByTestId("git-network-fetch").isDisabled(), true);
    await page.getByRole("button", { name: "刷新本地状态", exact: true }).click();
    assert.deepEqual(await writes(), []);
    await page.getByRole("checkbox", { name: "选择远端 origin" }).check();
    await page.getByRole("checkbox", { name: "选择远端 backup" }).check();
    await action("partial");
    await page.getByTestId("git-network-fetch").click();
    await settle();
    const receipt = page.getByTestId("git-network-receipt");
    assert.match(await receipt.innerText(), /部分成功/);
    assert.match(await receipt.innerText(), /backup.*失败/);
    assert.deepEqual((await writes())[0].params.remotes, ["origin", "backup"]);
    assert.equal(await page.getByTestId("network-refresh-count").textContent(), "1");
  });
  await t.test("配置与上游先确认再写，新增编辑重命名删除和取消范围明确", async () => {
    await go();
    await page.getByRole("button", { name: "新增远端", exact: true }).click();
    await page.getByRole("textbox", { name: "远端名称", exact: true }).fill("review");
    await page
      .getByRole("textbox", { name: "Fetch URL", exact: true })
      .fill("https://example.invalid/review.git");
    await page.getByRole("button", { name: "查看确认", exact: true }).click();
    assert.deepEqual(await writes(), []);
    await page.getByTestId("git-network-confirm").click();
    await settle();
    await page.getByRole("button", { name: "编辑远端 review" }).click();
    await page
      .getByRole("textbox", { name: "Push URL", exact: true })
      .fill("ssh://git@example.invalid/review.git");
    await page.getByRole("button", { name: "查看确认", exact: true }).click();
    await page.getByTestId("git-network-confirm").click();
    await settle(2);
    await page.getByRole("button", { name: "重命名远端 review" }).click();
    await page.getByRole("textbox", { name: "新远端名称" }).fill("renamed");
    await page.getByRole("button", { name: "查看确认", exact: true }).click();
    await page.getByTestId("git-network-confirm").click();
    await settle(3);
    await page.getByRole("button", { name: "删除远端 renamed" }).click();
    assert.match(await page.getByTestId("git-network-confirmation").innerText(), /不删除服务器/);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await writes()).length, 3);
    await page.getByRole("button", { name: "删除远端 renamed" }).click();
    await page.getByTestId("git-network-confirm").click();
    await settle(4);
    await page.getByRole("combobox", { name: "跟踪上游" }).selectOption("none");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal((await writes()).length, 4);
    await page.getByTestId("git-network-confirm").click();
    await settle(5);
    assert.equal((await writes())[4].params.upstream, null);
  });
  await t.test("仅快进预览冻结提交，阻塞不可确认，快速双击只写一次", async () => {
    await go();
    await action("reason", "diverged");
    await page.getByTestId("git-network-update").click();
    await page.getByTestId("git-network-confirmation").waitFor();
    assert.match(await page.getByTestId("git-network-confirmation").innerText(), /分叉/);
    assert.equal(await page.getByTestId("git-network-confirm").isDisabled(), true);
    assert.deepEqual(await writes(), []);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await action("reason", "ready");
    await page.getByTestId("git-network-update").click();
    await page.getByTestId("git-network-confirm").waitFor();
    await action("hold");
    await page.getByTestId("git-network-confirm").evaluate((button) => {
      button.click();
      button.click();
    });
    await action("release");
    await settle();
    assert.equal((await writes())[0].method, "fastForward");
    assert.equal((await writes())[0].params.preview.target, "b".repeat(40));
  });
  await t.test("同路径换 Host 使旧预览失效，远端命令贯通 identity，断连不回落本地", async () => {
    await go();
    await action("hold");
    await page.getByTestId("git-network-update").click();
    await action("remote");
    await page.getByRole("checkbox", { name: "选择远端 origin" }).waitFor();
    await action("release");
    assert.equal(await page.getByTestId("git-network-confirmation").count(), 0);
    await page.getByRole("checkbox", { name: "选择远端 origin" }).check();
    await page.getByTestId("git-network-fetch").click();
    await settle();
    const call = (await writes())[0];
    assert.equal(call.host, "remote");
    assert.equal(call.params.workspaceIdentity, "fixture:remote");
    assert.equal(call.params.workspacePath, "/fixture/repo");
    await action("disconnect");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-network-fetch"]').disabled,
    );
    assert.equal((await writes()).length, 1);
  });
  await t.test("重开页面只查询原请求收据，不重放 Fetch", async () => {
    await go();
    await page.getByRole("checkbox", { name: "选择远端 origin" }).check();
    await page.getByTestId("git-network-fetch").click();
    await settle();
    const requestId = (await writes())[0].params.requestId;
    await page.getByTestId("git-view-changes").click();
    await page.getByTestId("git-view-network").click();
    await page.getByTestId("git-network-receipt").waitFor();
    assert.equal((await writes()).length, 1);
    assert.match(await page.getByTestId("git-network-receipt").innerText(), /成功/);
    assert.ok(
      await page.evaluate(
        (id) =>
          globalThis.__gitNetwork.calls.some(
            (call) => call.method === "receipt" && call.params.requestId === id,
          ),
        requestId,
      ),
    );
  });
  await t.test("回执丢失刷新原收据，已成功 Fetch 不重发", async () => {
    await go();
    await action("lostAck");
    await page.getByRole("checkbox", { name: "选择远端 origin" }).check();
    await page.getByTestId("git-network-fetch").click();
    await page.getByTestId("git-network-error").waitFor();
    assert.equal((await writes()).length, 1);
    await page.getByRole("button", { name: "刷新本地状态", exact: true }).click();
    await page.getByTestId("git-network-receipt").waitFor();
    assert.match(await page.getByTestId("git-network-receipt").innerText(), /成功/);
    assert.equal((await writes()).length, 1);
  });
  await t.test("390px 及英文暗色布局无横向溢出，键盘可操作", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go();
    await action("theme", "zai-light");
    await page.getByRole("checkbox", { name: "选择远端 origin" }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.getByTestId("git-network-fetch").isEnabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const contrast = async () =>
      page.getByTestId("git-network-pane").evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        const luminance = (color) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const data = ctx.getImageData(0, 0, 1, 1).data;
          const values = [...data].slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const label = [...element.querySelectorAll("span")].find(
          (node) => node.textContent === "origin",
        );
        const foreground = luminance(getComputedStyle(label).color),
          background = luminance(getComputedStyle(element).backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
    assert.ok((await contrast()) >= 4.5, "light theme text contrast");
    assert.ok(
      await page
        .getByTestId("git-network-pane")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    );
    await mkdir("artifacts/git-network", { recursive: true });
    await page.screenshot({ path: "artifacts/git-network/mobile-light.png" });
    await page.goto(fixtureUrl + "?english");
    await page.getByTestId("git-view-network").click();
    await page.getByRole("checkbox", { name: "Select remote origin" }).waitFor();
    await action("theme", "zai-dark");
    assert.ok((await contrast()) >= 4.5, "dark theme text contrast");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: "artifacts/git-network/mobile-dark-en.png" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await action("theme", "zai-light");
    await page.getByTestId("git-network-update").click();
    await page.getByTestId("git-network-confirmation").waitFor();
    await page.screenshot({ path: "artifacts/git-network/desktop-preview-light.png" });
    await action("theme", "zai-dark");
  });
}
