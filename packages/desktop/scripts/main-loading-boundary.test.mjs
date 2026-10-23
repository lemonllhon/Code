import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Main platform entry excludes full Host composition and execution services", async () => {
  const reports = [];
  const exports =
    "createCredentialService,createSettingService,createTelemetryCore,createTelemetryUserIdLoader,createTelemetryAuthorizationLoader,createTelemetryMarketingParamsLoader,getAppConfigDir,getDataBaseDir,setDataBaseDir,getConversationWorkspaceDir,getLCodeDataRootDir,buildRuntimeProcessEnvPatch,captureLoginShellEnvSnapshot,normalizeRuntimeProcessEnv,createCuaHelperInstaller,canonicalizeCuaHelperInstallerOptions,createStorageService,createFsStorageCleaner,createStorageRootsResolver,createRuntimePackageCacheCleaner,runStorageScan,createFeedbackDiagnosticArchive,readLCodeStdioTapDevState,setLCodeStdioTapDevEnabled";
  for (const entry of ["node", "desktop-main"]) {
    const result = await build({
      stdin: {
        contents: `export {${exports}} from '@lcode/services/${entry}';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
      minify: true,
      logLevel: "silent",
      plugins: [
        {
          name: "entry",
          setup(builder) {
            builder.onResolve({ filter: /^@lcode\/services\/(node|desktop-main)$/ }, (args) => ({
              path: resolve(`packages/services/src/${args.path.split("/").at(-1)}.ts`),
            }));
          },
        },
      ],
    });
    const included = Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, value]) => value.bytesInOutput > 0)
        .map(([path]) => path),
    );
    reports.push({ entry, bytes: result.outputFiles[0].contents.length, modules: included.length });
    if (entry === "desktop-main") {
      assert.ok(
        !included.some((path) =>
          /lcodeAgentProcessManager|lcodeAgentService|terminalService|services\/src\/node\.ts$/.test(
            path,
          ),
        ),
        included.join("\n"),
      );
    }
  }
  assert.ok(reports[1].bytes < reports[0].bytes);
  await mkdir(".artifacts/desktop-memory", { recursive: true });
  await writeFile(
    ".artifacts/desktop-memory/main-loading.json",
    JSON.stringify(
      {
        measurement: "identical platform exports with identical external rules; not process RAM",
        reports,
      },
      null,
      2,
    ),
  );
});
