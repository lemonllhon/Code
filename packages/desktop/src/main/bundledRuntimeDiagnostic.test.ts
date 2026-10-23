import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LCODE_AGENT_RUNTIME } from "@lcode/shared";
import {
  inspectBundledAgentRuntime,
  logWindowsBundledRuntimeIntegrityDiagnostic,
} from "./bundledRuntimeDiagnostic.js";

const cache = resolve(import.meta.dirname, "../../node_modules/.cache");
async function resources(t: { after: (fn: () => Promise<void>) => void }) {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "runtime-diagnostic-"));
  t.after(async () => {
    const child = relative(cache, root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith(".."));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, LCODE_AGENT_RUNTIME.bundledResourceDir));
  return root;
}

for (const platform of ["win32", "darwin", "linux"]) {
  for (const kind of ["node-bundle", "native-binary"] as const) {
    test(`${platform}: ${kind} alone is a valid bundled Agent entry`, async (t) => {
      const root = await resources(t);
      const entry =
        kind === "node-bundle"
          ? LCODE_AGENT_RUNTIME.resolveNodeBundleSegments()
          : LCODE_AGENT_RUNTIME.resolveEntrySegments(platform);
      await writeFile(
        join(root, LCODE_AGENT_RUNTIME.bundledResourceDir, ...entry),
        "synthetic runtime",
      );
      const status = await inspectBundledAgentRuntime(root, platform);
      assert.equal(status.find((item) => item.kind === kind)?.status, "available");
      assert.equal(status.filter((item) => item.status === "available").length, 1);
      const warnings: unknown[] = [];
      await logWindowsBundledRuntimeIntegrityDiagnostic({
        platform,
        isPackaged: true,
        resourcesPath: root,
        logger: {
          warn: (...args) => {
            warnings.push(args);
          },
        },
      });
      assert.deepEqual(warnings, []);
    });
  }
}

test("only a real missing installation warns; native directory cannot masquerade as a binary", async (t) => {
  const root = await resources(t);
  const warnings: unknown[] = [];
  const options = {
    platform: "win32",
    isPackaged: true,
    resourcesPath: root,
    logger: {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
  };
  await logWindowsBundledRuntimeIntegrityDiagnostic(options);
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /desktop.runtime.bundled_unavailable/);
  assert.equal(JSON.stringify(warnings).includes(root), false);
  const native = join(
    root,
    LCODE_AGENT_RUNTIME.bundledResourceDir,
    ...LCODE_AGENT_RUNTIME.resolveEntrySegments("win32"),
  );
  await mkdir(native);
  assert.equal(
    (await inspectBundledAgentRuntime(root, "win32")).find((item) => item.kind === "native-binary")
      ?.status,
    "not-file",
  );
  await writeFile(
    join(
      root,
      LCODE_AGENT_RUNTIME.bundledResourceDir,
      ...LCODE_AGENT_RUNTIME.resolveNodeBundleSegments(),
    ),
    "bundle",
  );
  await logWindowsBundledRuntimeIntegrityDiagnostic(options);
  assert.equal(warnings.length, 1, "valid Node bundle overrides the unavailable native entry");
});

test("unreadable entries remain diagnostic failures and do not become false missing files", async () => {
  const warnings: unknown[] = [];
  await logWindowsBundledRuntimeIntegrityDiagnostic({
    platform: "win32",
    isPackaged: true,
    resourcesPath: "/synthetic/resources",
    inspectFile: async () => "unreadable",
    logger: {
      warn: (...args) => {
        warnings.push(args);
      },
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /unreadable/);
  assert.doesNotMatch(JSON.stringify(warnings), /missing/);
});

test("installations containing both supported entries do not warn", async (t) => {
  const root = await resources(t);
  for (const segments of [
    LCODE_AGENT_RUNTIME.resolveNodeBundleSegments(),
    LCODE_AGENT_RUNTIME.resolveEntrySegments("win32"),
  ]) {
    await writeFile(
      join(root, LCODE_AGENT_RUNTIME.bundledResourceDir, ...segments),
      "synthetic runtime",
    );
  }
  assert.equal(
    (await inspectBundledAgentRuntime(root, "win32")).every((item) => item.status === "available"),
    true,
  );
  await logWindowsBundledRuntimeIntegrityDiagnostic({
    platform: "win32",
    isPackaged: true,
    resourcesPath: root,
    logger: {
      warn: () => {
        throw new Error("unexpected warning");
      },
    },
  });
});

test("development and non-Windows startup do not inspect resources", async () => {
  for (const [platform, isPackaged] of [
    ["win32", false],
    ["darwin", true],
    ["linux", true],
  ] as const) {
    await logWindowsBundledRuntimeIntegrityDiagnostic({
      platform,
      isPackaged,
      resourcesPath: "/synthetic/resources",
      inspectFile: async () => {
        throw new Error("unexpected file access");
      },
      logger: {
        warn: () => {
          throw new Error("unexpected warning");
        },
      },
    });
  }
});
