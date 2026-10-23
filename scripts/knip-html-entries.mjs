import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Vite 测试页面通过 HTML 启动，不能将其未被 import 的辅助文件全部标记为入口。 */
export async function discoverHtmlEntries(
  workspaceRoot,
  directories,
  { webRoot = workspaceRoot } = {},
) {
  const result = new Set();
  const add = async (specifier, htmlPath) => {
    if (!specifier || /^(?:[\w+.-]+:|\/\/)/u.test(specifier)) return;
    const clean = specifier.split(/[?#]/u, 1)[0];
    const target = clean.startsWith("/")
      ? resolve(webRoot, `.${clean}`)
      : resolve(dirname(htmlPath), clean);
    const local = relative(workspaceRoot, target);
    if (!local || local === ".." || local.startsWith(`..${sep}`)) return;
    const exists = await stat(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (exists?.isFile()) result.add(local.split(sep).join("/"));
  };
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const child of children) {
      const file = resolve(directory, child.name);
      if (child.isDirectory()) await visit(file);
      else if (child.isFile() && child.name.endsWith(".html")) {
        const html = await readFile(file, "utf8");
        for (const [, attributes] of html.matchAll(/<link\b([^>]*)>/giu)) {
          if (/\brel\s*=\s*["']stylesheet["']/iu.test(attributes))
            await add(attributes.match(/\bhref\s*=\s*["']([^"']+)["']/iu)?.[1], file);
        }
        for (const [, attributes, body] of html.matchAll(
          /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu,
        )) {
          const src = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/iu)?.[1];
          if (src) await add(src, file);
          else if (/\btype\s*=\s*["']module["']/iu.test(attributes)) {
            for (const match of body.matchAll(
              /\bimport\s*(?:\(\s*|(?:[\w$*,{}\s]*\bfrom\s*)?)["']([^"']+)["']/gu,
            ))
              await add(match[1], file);
          }
        }
      }
    }
  };
  for (const directory of directories) await visit(resolve(workspaceRoot, directory));
  return [...result].sort();
}
