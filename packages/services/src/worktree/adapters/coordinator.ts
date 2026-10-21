import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "@lcode/shared/node";
import { isGitUnavailableError } from "@lcode/shared";
import type { CheckoutCoordinator, WorktreeGitPort } from "../nodeTypes.js";
import type { CheckoutLease } from "../contract.js";
import { canonicalCheckoutPath } from "./git.js";
import { createCheckoutReservations } from "./reservations.js";

export class CheckoutBusyError extends Error {
  readonly code = "LCODE_CHECKOUT_BUSY";
}

export function createCheckoutCoordinator(options: {
  dataDir: string;
  git: WorktreeGitPort;
  waitMs?: number;
}): CheckoutCoordinator {
  const leases = new Map<string, { ownerId: string; key: string; release: () => Promise<void> }>();
  const pending = new Map<string, Promise<CheckoutLease>>();
  const reservations = createCheckoutReservations(options.dataDir);
  return {
    getReservation: reservations.getReservation,
    setReservation: reservations.setReservation,
    clearReservation: reservations.clearReservation,
    assertAdmission: (params) => reservations.assertAdmission(params),
    async acquire(params) {
      const workspacePath = await canonicalCheckoutPath(options.git, params.workspacePath);
      const key = createHash("sha256")
        .update(process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath)
        .digest("hex");
      const resource = params.resource ?? "checkout";
      const ownerKey = JSON.stringify([
        key,
        params.ownerId,
        params.mode ?? "exclusive",
        resource,
        params.allowReservationKey,
      ]);
      const existing = pending.get(ownerKey);
      if (existing) return existing;
      const acquiring = (async () => {
        const releases: (() => Promise<void>)[] = [];
        const lock = async (directory: string, id: string, shared: boolean) => {
          const root = join(options.dataDir, directory);
          await mkdir(root, { recursive: true });
          releases.push(
            await acquireFileLock(
              join(root, id),
              [50, 100, 200, 500],
              10_000,
              params.waitMs ?? options.waitMs ?? 30_000,
              { shared, reclaimDeadOwners: params.waitMs === 0 },
            ),
          );
        };
        try {
          // Agent 的 shared admission 不写应用配置；Fetch 可与其并行，文件更新仍受 checkout 限制。
          if (resource !== "checkout" || params.mode !== "shared") {
            let common: string | null = null;
            try {
              const result = await options.git.run({
                cwd: workspacePath,
                args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              });
              if (result.timedOut || result.outputTruncated)
                throw new Error("Cannot resolve Git common directory");
              if (result.exitCode === 0) common = await realpath(result.stdout.trim());
              else if (resource !== "checkout") throw new Error("Git repository is unavailable");
            } catch (error) {
              if (resource !== "checkout" || !isGitUnavailableError(error)) throw error;
            }
            if (common) {
              const commonKey = createHash("sha256")
                .update(process.platform === "win32" ? common.toLowerCase() : common)
                .digest("hex");
              await lock("repository-locks", commonKey, resource === "checkout");
            }
          }
          if (resource !== "repository")
            await lock("checkout-locks", key, params.mode === "shared");
          if (resource !== "repository")
            await reservations.assertAdmission({ workspacePath }, params.allowReservationKey);
        } catch (error) {
          for (const release of [...releases].reverse()) await release();
          throw error;
        }
        const release = async () => {
          for (const unlock of [...releases].reverse()) await unlock();
        };
        const token = randomUUID();
        leases.set(token, { ownerId: params.ownerId, key: ownerKey, release });
        return { token, ownerId: params.ownerId, workspacePath };
      })();
      pending.set(ownerKey, acquiring);
      try {
        return await acquiring;
      } catch (error) {
        pending.delete(ownerKey);
        if ((error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT")
          throw new CheckoutBusyError("Checkout is busy; wait for its current writer to finish");
        throw error;
      }
    },
    async release(params) {
      const lease = leases.get(params.token);
      if (!lease) return;
      if (lease.ownerId !== params.ownerId) throw new Error("Checkout lease owner does not match");
      await lease.release();
      leases.delete(params.token);
      pending.delete(lease.key);
    },
  };
}
