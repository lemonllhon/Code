import { readFile } from "node:fs/promises";
import type { ProviderBuiltinAvailability } from "@lcode/shared";
import { decodeLCodeBuiltinRelease, type LCodeBuiltinRelease } from "./lcode-builtin-release.js";

export interface ReleaseCandidate {
  readonly state: ProviderBuiltinAvailability["bundled"];
  readonly release?: LCodeBuiltinRelease;
}

export async function readReleaseCandidate(filePath: string): Promise<ReleaseCandidate> {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return { state: "available", release: decodeLCodeBuiltinRelease(JSON.parse(raw)) };
    } catch {
      return { state: "invalid" };
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return {
      state:
        code === "ENOENT"
          ? "missing"
          : code === "EACCES" || code === "EPERM" || code === "EROFS"
            ? "permission-denied"
            : "io-error",
    };
  }
}

export class LCodeBuiltinUnavailableError extends Error {
  readonly code = "LCODE_BUILTIN_CONFIG_UNAVAILABLE";
  readonly availability: ProviderBuiltinAvailability;
  constructor(bundled: ReleaseCandidate, active: ReleaseCandidate | null) {
    super("Bundled 与 Active LCode Built-in Release 均不可用");
    this.availability = { bundled: bundled.state, active: active?.state ?? "missing" };
  }
}
