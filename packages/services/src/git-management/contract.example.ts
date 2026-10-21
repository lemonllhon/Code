import type { IGitManagementService } from "./contract.js";
export async function readGitAccountNames(service: IGitManagementService): Promise<string[]> {
  return (await service.getSnapshot()).accounts.map((account) => account.name);
}
