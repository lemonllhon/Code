import assert from "node:assert/strict";

export function waitForComposerStrength(page, strength) {
  return page.waitForFunction((expected) => {
    const shell = document.querySelector(".chat-prompt-shell");
    return (
      Number(getComputedStyle(shell).getPropertyValue("--composer-model-strength")) === expected &&
      Number(getComputedStyle(shell, "::before").opacity) === expected
    );
  }, strength);
}

export async function verifyComposerLevels(page, shell, choose, artifacts, width) {
  const defaults = [];
  for (const model of ["demo", "gpt-6.1-sol", "gpt-6-luna"]) {
    await choose(model);
    await page.getByTestId("chat-thought-level-select-trigger").click();
    const slider = page.getByRole("slider");
    const levels = [];
    for (const [index, key] of ["Home", "ArrowRight", "ArrowRight", "End"].entries()) {
      await slider.press(key);
      // 所有档位现在都开启，不能再用布尔标记等待受控草稿提交；等待当前档位强度再读取过渡。
      await waitForComposerStrength(page, [0.28, 0.52, 0.76, 1][index]);
      await shell.evaluate((element) => {
        element.getBoundingClientRect();
        return Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      levels.push(
        await shell.locator(".composer-model-sparks").evaluate((element) => {
          const particle = element.querySelector(".composer-model-spark");
          return {
            glow: Number(getComputedStyle(element.parentElement, "::before").opacity),
            scale: Number(getComputedStyle(particle).scale),
            rate: particle.getAnimations()[0].playbackRate,
            visible: [...element.children].filter(
              (child) => getComputedStyle(child).display !== "none",
            ).length,
          };
        }),
      );
      if (model === "demo" && (index === 0 || index === 3)) {
        await shell.screenshot({
          path: `${artifacts}/${width}-${index === 0 ? "default" : "ultra"}.png`,
          animations: "allow",
        });
      }
    }
    for (let index = 1; index < levels.length; index++) {
      const diagnostic = JSON.stringify({ model, levels });
      assert.ok(levels[index].glow > levels[index - 1].glow, diagnostic);
      assert.ok(levels[index].rate > levels[index - 1].rate, diagnostic);
      assert.ok(levels[index].scale > levels[index - 1].scale, diagnostic);
      assert.ok(levels[index].visible >= levels[index - 1].visible, diagnostic);
    }
    assert.equal(levels[0].glow, 0.28);
    defaults.push(levels[0]);
    await slider.press("ArrowLeft");
    await waitForComposerStrength(page, 0.76);
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-thought-level-slider-panel").waitFor({ state: "detached" });
    assert.equal(await shell.getAttribute("data-composer-model-emphasis"), "true");
  }
  assert.deepEqual(defaults[0], defaults[1]);
  assert.deepEqual(defaults[1], defaults[2]);
}
