import type { BackupRequest } from "./contract.js";
export const providerBackupExample: BackupRequest = {
  kind: "providers",
  operationId: "example-backup",
  locations: ["local"],
};
