import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readGitDetectionFile(path: string, limit = 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > limit) throw new Error("unsupported-file");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > limit) throw new Error("unsupported-file");
  return content;
}

export function gitCliConfigSources(
  home: string,
  configHome: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const xdg = environment.XDG_CONFIG_HOME || configHome;
  const appData = environment.APPDATA || environment.AppData || join(home, "AppData", "Roaming");
  const gh =
    environment.GH_CONFIG_DIR ||
    (environment.XDG_CONFIG_HOME
      ? join(xdg, "gh")
      : platform === "win32"
        ? join(appData, "GitHub CLI")
        : join(configHome, "gh"));
  // CLI 的当前目录优先；只在未指定覆盖路径时兼容已有的 XDG 布局，避免遗漏迁移前的账号。
  const tea = environment.TEA_CONFIG_DIR
    ? [environment.TEA_CONFIG_DIR]
    : [
        join(xdg, "tea"),
        ...(platform === "win32"
          ? [join(appData, "tea")]
          : platform === "darwin"
            ? [join(home, "Library", "Application Support", "tea")]
            : []),
      ];
  return [
    { path: join(gh, "hosts.yml"), provider: "github" as const },
    // Windows 上 gh 的原生目录与旧版 .config 目录可能同时存在；显式覆盖时只读选定目录。
    ...(!environment.GH_CONFIG_DIR && !environment.XDG_CONFIG_HOME && platform === "win32"
      ? [{ path: join(configHome, "gh", "hosts.yml"), provider: "github" as const }]
      : []),
    ...(environment.GLAB_CONFIG_DIR
      ? [environment.GLAB_CONFIG_DIR]
      : [
          join(configHome, "glab-cli"),
          join(xdg, "glab-cli"),
          ...(platform === "win32"
            ? [
                join(
                  environment.LOCALAPPDATA ||
                    environment.LocalAppData ||
                    join(home, "AppData", "Local"),
                  "glab-cli",
                ),
              ]
            : platform === "darwin"
              ? [join(home, "Library", "Application Support", "glab-cli")]
              : []),
        ]
    ).map((directory) => ({ path: join(directory, "config.yml"), provider: "gitlab" as const })),
    ...tea.map((directory) => ({
      path: join(directory, "config.yml"),
      provider: "gitea" as const,
    })),
  ].filter((source, index, all) => all.findIndex((other) => other.path === source.path) === index);
}
