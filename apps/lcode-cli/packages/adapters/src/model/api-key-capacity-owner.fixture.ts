import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";

const owner = new FileSharedQuotaCoordinator(process.argv[2]!);
const lease = await owner.reserve({
  providerId: "fixture",
  poolId: "team",
  keyId: "fixture",
  maxInFlight: 1,
  request: { attemptId: "child", scopeKey: "fixture", createdAt: Date.now() },
  windows: [],
});
await owner.dispatch(lease);
process.on("message", () => {
  void owner.finish(lease, "cancelled").then(() => process.disconnect());
});
process.send!("ready");
