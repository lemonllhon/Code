import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { createSettingsPageConfig } from "./settingsPageConfig.js";

test("各组按当前语言名称从短到长排列，等长保留注册顺序且不改变注册配置", () => {
  const original = createSettingsPageConfig({ isDesktop: true });
  for (const messages of [zhCN, enUS]) {
    const getSectionTitle = (id: string) => {
      const title = messages[id];
      assert.ok(typeof title === "string", `missing title: ${id}`);
      return title;
    };
    const sorted = createSettingsPageConfig({ isDesktop: true, getSectionTitle });
    assert.deepEqual(sorted.settingsSections, original.settingsSections);
    assert.deepEqual(
      sorted.settingsSectionGroups.map((group) => group.id),
      original.settingsSectionGroups.map((group) => group.id),
    );
    for (const group of sorted.settingsSectionGroups) {
      const previous = original.settingsSectionGroups.find((entry) => entry.id === group.id)!;
      const remoteIndex = group.sections.findIndex((section) => section.id === "remoteControl");
      if (remoteIndex >= 0) {
        assert.equal(group.sections[remoteIndex + 1]?.id, "remoteDevices");
        assert.equal(group.sections[remoteIndex + 2]?.id, "modelProvider");
      }
      const comparable =
        remoteIndex >= 0
          ? group.sections.filter(
              (section) => section.id !== "modelProvider" && section.id !== "remoteDevices",
            )
          : group.sections;
      for (let index = 1; index < comparable.length; index++) {
        const current = comparable[index]!;
        const preceding = comparable[index - 1]!;
        const currentLength = Array.from(
          getSectionTitle(current.titleId).replace(/\s/gu, ""),
        ).length;
        const precedingLength = Array.from(
          getSectionTitle(preceding.titleId).replace(/\s/gu, ""),
        ).length;
        assert.ok(currentLength >= precedingLength, `${group.id}: ${current.id}`);
        if (currentLength === precedingLength) {
          assert.ok(previous.sections.indexOf(current) > previous.sections.indexOf(preceding));
        }
      }
    }
  }
  assert.deepEqual(createSettingsPageConfig({ isDesktop: true }), original);
});

test("标题空白不影响长度，同长度稳定排序，Web 平台继续隐藏桌面分区", () => {
  const original = createSettingsPageConfig();
  const sorted = createSettingsPageConfig({ getSectionTitle: () => "同 长" });
  assert.deepEqual(sorted.settingsSectionGroups, original.settingsSectionGroups);
  assert.equal(
    sorted.settingsSections.some(
      (entry) =>
        entry.id === "remoteControl" || entry.id === "computerUse" || entry.id === "remoteDevices",
    ),
    false,
  );
});

test("远程设备在三种桌面平台的基础设置中注册，与手机远程控制保持独立", () => {
  for (const platform of [
    { isDesktop: true },
    { isMacDesktop: true },
    { isWindowsDesktop: true },
  ]) {
    const config = createSettingsPageConfig(platform);
    const basics = config.settingsSectionGroups.find((group) => group.id === "basics")!;
    assert.equal(basics.sections.filter((section) => section.id === "remoteDevices").length, 1);
    assert.equal(basics.sections.filter((section) => section.id === "remoteControl").length, 1);
  }
});
