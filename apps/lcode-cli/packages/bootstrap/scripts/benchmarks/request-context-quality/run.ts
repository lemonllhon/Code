import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ModelInputMessage, ModelUsage } from "@lcode/contracts";
import type { ModelSelection } from "@lcode/provider";
import { modelSelectionSchema } from "@lcode/shared/model-selection";
import { prepareProvider, type EphemeralConnection } from "./provider.js";

type Arm = "baseline" | "gitOnly" | "optimized";
interface Fixture {
  id: string;
  scenario: string;
  mcs: boolean;
  expectedFacts: string;
  baseline: ModelInputMessage[];
  gitOnly: ModelInputMessage[];
  optimized: ModelInputMessage[];
}
const allowedScenarios = new Set([
  "release-unchanged",
  "plain-project",
  "fetch-failure",
  "account-changed",
  "explicit-confirm",
  "reference-layout",
]);
const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const output = arg("--output");
if (!output) throw new Error("output_required");
const report: Record<string, unknown> = {
  schemaVersion: 1,
  status: "preparing",
  syntheticOnly: true,
  results: [],
  limitations: [
    "Exploratory paired continuation probes, not end-to-end task execution or proof of universal behavior.",
    "Synthetic tools already completed; no real workspace, account binding, session creation or Git operation.",
    "Provider cache/load not controlled. Regex counts are auxiliary; manually review synthetic output for factual correctness and useful progress.",
    "Missing usage is null, not zero. Failed/truncated samples remain in the report; no selective reruns.",
  ],
};
const results = report.results as Array<Record<string, unknown>>;
const save = () => writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const safeReason = (error: unknown) =>
  error instanceof Error && /^[a-z_]+$/u.test(error.message)
    ? error.message
    : "preflight_or_provider_failed";
try {
  const fixturePath = arg("--fixtures"),
    selectionsPath = arg("--selections");
  if (!fixturePath || (!selectionsPath && !process.argv.includes("--connection-stdin")))
    throw new Error("inputs_required");
  const fixtureText = await readFile(fixturePath, "utf8");
  const bundle = JSON.parse(fixtureText) as {
    schemaVersion: number;
    syntheticOnly: boolean;
    cases: Fixture[];
  };
  if (
    bundle.schemaVersion !== 1 ||
    bundle.syntheticOnly !== true ||
    bundle.cases.length !== 12 ||
    bundle.cases.some((item) => !allowedScenarios.has(item.scenario))
  )
    throw new Error("fixture_invalid");
  let connection: EphemeralConnection | undefined;
  if (process.argv.includes("--connection-stdin")) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write("awaiting_ephemeral_connection_on_stdin\n");
    const reader = createInterface({ input: process.stdin, terminal: false });
    const line = await new Promise<string>((resolve) => reader.once("line", resolve));
    reader.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    const value: unknown = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      !("baseUrl" in value) ||
      !("apiKey" in value) ||
      !("modelId" in value) ||
      typeof value.baseUrl !== "string" ||
      typeof value.apiKey !== "string" ||
      typeof value.modelId !== "string" ||
      !value.apiKey ||
      !value.modelId
    )
      throw new Error("connection_invalid");
    const url = new URL(value.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("connection_invalid");
    connection = { baseUrl: value.baseUrl, apiKey: value.apiKey, modelId: value.modelId };
  }
  const rawSelections: unknown = connection
    ? [{ providerId: "synthetic-evaluation", modelId: connection.modelId }]
    : JSON.parse(await readFile(selectionsPath!, "utf8"));
  if (!Array.isArray(rawSelections) || !rawSelections.length || rawSelections.length > 2)
    throw new Error("selections_invalid");
  const selections: ModelSelection[] = rawSelections.map((value) =>
    modelSelectionSchema.parse(value),
  );
  const pairs = Number(arg("--pairs") ?? 2);
  if (!Number.isInteger(pairs) || pairs < 2 || pairs > 3) throw new Error("pairs_invalid");
  const requestLimit = pairs * selections.length * bundle.cases.length * 3;
  const tokenLimit = Number(arg("--token-limit") ?? 400_000);
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1 || tokenLimit > 1_000_000)
    throw new Error("token_limit_invalid");
  report.settings = {
    selections,
    pairs,
    requestLimit,
    tokenLimit,
    fixtureHash: createHash("sha256").update(fixtureText).digest("hex"),
    maxOutputTokens: 2048,
    retries: 0,
    requestTimeoutMs: 60000,
    output: "synthetic_response_only",
    modelIoRecording: false,
  };
  const models = [];
  for (const selection of selections) models.push(await prepareProvider(selection, connection));
  (report.settings as Record<string, unknown>).selections = models.map((value) => value.selection);
  const resumePath = arg("--resume");
  if (resumePath) {
    const prior = JSON.parse(await readFile(resumePath, "utf8")) as typeof report;
    const priorSettings = prior.settings as Record<string, unknown>;
    const settings = report.settings as Record<string, unknown>;
    if (
      prior.status !== "incomplete" ||
      priorSettings.fixtureHash !== settings.fixtureHash ||
      priorSettings.pairs !== pairs ||
      JSON.stringify(priorSettings.selections) !== JSON.stringify(settings.selections) ||
      !Array.isArray(prior.results)
    )
      throw new Error("resume_mismatch");
    results.push(...prior.results);
    report.resume = {
      previousSamples: results.length,
      previousTokenLimit: priorSettings.tokenLimit,
      previousReason: prior.reason,
    };
  }
  if (process.argv.includes("--preflight")) {
    report.status = "preflight_passed_no_model_calls";
  } else {
    report.status = "running";
    let tokens = results.reduce(
      (total, result) =>
        total +
        ((result.usage as ModelUsage | null)?.totalTokens ??
          Number(result.inputCharacters) * 3 + 2048),
      0,
    );
    let position = 0;
    for (const [modelIndex, prepared] of models.entries()) {
      for (let pair = 0; pair < pairs; pair++) {
        const arms: Arm[] =
          pair % 2 ? ["optimized", "gitOnly", "baseline"] : ["baseline", "gitOnly", "optimized"];
        for (const fixture of bundle.cases)
          for (const arm of arms) {
            const existing = results[position++];
            if (existing) {
              if (
                existing.modelIndex !== modelIndex ||
                existing.pair !== pair + 1 ||
                existing.fixture !== fixture.id ||
                existing.arm !== arm
              )
                throw new Error("resume_mismatch");
              continue;
            }
            if (tokens >= tokenLimit) throw new Error("token_budget_exhausted");
            const started = performance.now();
            let firstTextMs: number | null = null,
              text = "",
              usage: ModelUsage | null = null,
              finishReason: string | null = null;
            let failure: string | null = null;
            const messages = fixture[arm];
            const reservation =
              Buffer.byteLength(JSON.stringify(messages), "utf8") + prepared.maxOutputTokens;
            if (tokens + reservation > tokenLimit) throw new Error("token_budget_exhausted");
            try {
              for await (const event of prepared.model.streamText({
                messages,
                tools: [],
                options: { maxOutputTokens: prepared.maxOutputTokens },
                abortSignal: AbortSignal.timeout(60000),
              })) {
                if (event.type === "text_delta") {
                  firstTextMs ??= performance.now() - started;
                  text += event.text;
                } else if (event.type === "finish") {
                  usage = event.usage ?? null;
                  finishReason = event.finishReason;
                } else if (event.type === "error") throw new Error("provider_failed");
                else if (event.type === "tool_call") throw new Error("unexpected_tool_call");
              }
              if (!finishReason) throw new Error("incomplete_stream");
            } catch (error) {
              failure = safeReason(error);
            }
            if (usage?.totalTokens !== undefined) tokens += usage.totalTokens;
            // 缺少 usage 时按输入字符数和输出上限预留预算，不把未知用量记为零继续无限调用。
            else tokens += reservation;
            results.push({
              modelIndex,
              pair: pair + 1,
              fixture: fixture.id,
              arm,
              failure,
              finishReason,
              firstTextMs,
              durationMs: performance.now() - started,
              inputCharacters: JSON.stringify(messages).length,
              usage,
              response: text,
              auxiliaryAccountMentions: (text.match(/账号|绑定|fixture-alice|fixture-bob/gu) ?? [])
                .length,
            });
            await save();
            if (results.length % 6 === 0)
              process.stdout.write(`${JSON.stringify({ samples: results.length })}\n`);
            if (failure) throw new Error("provider_probe_failed");
          }
      }
    }
    report.status = results.some((result) => result.failure)
      ? "completed_with_failures"
      : "completed_needs_semantic_review";
  }
} catch (error) {
  report.status = results.length ? "incomplete" : "preflight_blocked";
  report.reason = safeReason(error);
  process.exitCode = 1;
}
await save();
process.stdout.write(
  `${JSON.stringify({ status: report.status, reason: report.reason ?? null, samples: results.length })}\n`,
);
