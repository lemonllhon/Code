import { assertMemoryRoot, type MemoryRootRegistry } from "./project-memory-paths.js";
import { toFileSystemError } from "./file-system-common.js";
import { memoryError } from "./project-memory-io.js";

export async function guardOrdinaryMemoryMutation(
  registry: MemoryRootRegistry,
  path: string,
  action: "remove" | "mkdir",
): Promise<void> {
  try {
    const root = await registry.route(path);
    if (!root) return;
    await assertMemoryRoot(root);
    if (action === "remove" && /\.md$/iu.test(path))
      throw memoryError(
        "unsupported",
        path,
        "Project Memory deletion is not supported by the managed writer",
      );
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}
