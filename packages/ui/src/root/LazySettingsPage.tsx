import { lazy, Suspense, type ComponentProps } from "react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

// Root 两个设置入口共用一次加载；设置功能未打开时不解析其插件、统计和迁移面板。
const SettingsPage = lazy(() =>
  import("@/SettingsPage.js").then((module) => ({ default: module.SettingsPage })),
);

export function LazySettingsPage(props: ComponentProps<typeof SettingsPage>) {
  const { intl } = useLCodeIntl();
  return (
    <Suspense
      fallback={
        <div
          className="flex h-full items-center justify-center text-ui-base text-foreground-subtle"
          role="status"
          aria-busy="true"
        >
          {intl.formatMessage({ id: "common.loading" })}
        </div>
      }
    >
      <SettingsPage {...props} />
    </Suspense>
  );
}
