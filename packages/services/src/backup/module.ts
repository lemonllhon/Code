export const backupModule = {
  id: "backup",
  requires: ["shared"],
  provides: ["backup-lifecycle"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
