import type { TestContext } from "node:test";
import { join } from "node:path";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";
export async function historyFixture(t: TestContext, wrap?: Parameters<typeof publishFixture>[1]) {
  const f = await publishFixture(t, wrap),
    coordinator = createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command });
  const options = {
    commandProvider: f.command,
    reviewStateDataDir: join(f.base, "receipts"),
    checkoutCoordinator: coordinator,
  };
  return {
    ...f,
    scope: f.request,
    options,
    coordinator,
    service: coordinateGitCheckoutWrites(createGitService(options), coordinator),
  };
}
