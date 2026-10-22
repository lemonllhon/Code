import { readFile } from "node:fs/promises";
import { applyProviderCompatibility } from "./vendor-compatibility-patch.mjs";

const root = new URL("../vendor/", import.meta.url);
async function moduleUrl(path: string, exports: string[] = []): Promise<string> {
  let source = applyProviderCompatibility(
    path,
    await readFile(new URL(path + ".source", root), "utf8"),
  );
  if (exports.length) source += `\nexport { ${exports.join(", ")} };\n`;
  for (const match of source.matchAll(/from\s*["'](\.\/[^"']+\.mjs)["']/g)) {
    const child = path.slice(0, path.lastIndexOf("/") + 1) + match[1]!.slice(2);
    source = source.replace(match[0], "from " + JSON.stringify(await moduleUrl(child)));
  }
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}
export async function loadPatchedVendor(path: string, exports: string[] = []) {
  return import(await moduleUrl(path, exports));
}
export function sseData(wire: string) {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
}
