import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Scheduler public entry excludes unrelated Agent/plugin/terminal implementations", async () => {
  const reports = [];
  for (const name of ["node", "scheduler"]) {
    const result = await build({
      stdin: {
        contents: `import{AutomationRepo,OffPeakTaskRepo,computeAutomationNextRunAt,isOneShotAutomation}from'@lcode/services/${name}';globalThis.schedulerAPI={AutomationRepo,OffPeakTaskRepo,computeAutomationNextRunAt,isOneShotAutomation};`,
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
          name: "service-entry",
          setup(builder) {
            builder.onResolve({ filter: /^@lcode\/services\/(node|scheduler)$/ }, () => ({
              path: resolve(`packages/services/src/${name}.ts`),
            }));
          },
        },
      ],
    });
    const included = Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, value]) => value.bytesInOutput > 0)
        .map(([name]) => name),
    );
    reports.push({
      entry: name,
      bytes: result.outputFiles[0].contents.length,
      modules: included.length,
    });
    if (name === "scheduler")
      assert.ok(
        !included.some((name) =>
          /lcode-agent|lcode-cua|terminalService|pluginManagement/.test(name),
        ),
        included
          .filter((name) => /lcode-agent|lcode-cua|terminalService|pluginManagement/.test(name))
          .join("\n"),
      );
  }
  assert.ok(reports[1].bytes < reports[0].bytes);
  const artifacts = resolve(".artifacts/desktop-memory");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, "scheduler-loading.json"),
    JSON.stringify(
      {
        measurement: "bundled services graph; external packages excluded equally; not process RAM",
        reports,
      },
      null,
      2,
    ),
  );
});
