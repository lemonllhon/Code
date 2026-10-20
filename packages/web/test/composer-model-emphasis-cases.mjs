import assert from "node:assert/strict";

export async function verifyLightComposerTheme(shell, theme) {
  const presentation = await shell.evaluate((element) => {
    const style = getComputedStyle(element);
    const particle = element.querySelector(".composer-model-spark");
    const color = getComputedStyle(particle).backgroundColor;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (value) => {
      const [r, g, b] = pixels(value).map((channel) => {
        const srgb = channel / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const foreground = luminance(color);
    const surface = luminance(style.backgroundColor);
    return {
      contrast: (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05),
      chroma: Number(color.match(/^oklch\([\d.]+ ([\d.]+)/)?.[1]),
      borderAlpha: pixels(style.borderTopColor)[3] / 255,
      // 浏览器解析后的底光 alpha 能区分轻薄层次与大面积彩色填充，不依赖主题名称。
      washAlpha: [
        ...getComputedStyle(element, "::before").backgroundImage.matchAll(/\/ ([\d.]+)\)/g),
      ].map((match) => Number(match[1])),
    };
  });
  const diagnostic = JSON.stringify({ theme, ...presentation });
  assert.ok(presentation.contrast >= 4.5, diagnostic);
  assert.ok(presentation.chroma <= 0.09, diagnostic);
  assert.ok(presentation.borderAlpha <= 0.1, diagnostic);
  assert.ok(
    presentation.washAlpha.length > 0 && Math.max(...presentation.washAlpha) <= 0.05,
    diagnostic,
  );
}

export async function verifyLightComposerInput(page, editor, sparkPresentation) {
  await page.evaluate(() => {
    document.documentElement.className = "theme-zai-light";
  });
  await page.waitForFunction(
    () =>
      Number(
        getComputedStyle(document.querySelector(".composer-model-sparks")).getPropertyValue(
          "--composer-spark-boost",
        ),
      ) === 0,
  );
  const idle = await sparkPresentation();
  await editor.press("L");
  const typing = await sparkPresentation();
  // 白底上增亮会冲淡火花；真实键入必须加深粒子，同时保留加速、放大及自然复位。
  assert.ok(Number(typing.filter.match(/brightness\(([^)]+)\)/)?.[1]) < 0.85);
  assert.ok(typing.boost > 0.8 && typing.rate > idle.rate * 2 && typing.scale > idle.scale * 1.4);
  await page.waitForFunction(
    () =>
      Number(
        getComputedStyle(document.querySelector(".composer-model-sparks")).getPropertyValue(
          "--composer-spark-boost",
        ),
      ) === 0,
  );
  assert.deepEqual(await sparkPresentation(), idle);
  await page.evaluate(() => {
    document.documentElement.className = "dark theme-inkpurple";
  });
}

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
