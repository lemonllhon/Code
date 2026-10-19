import { createServer } from "node:http";

/** 仅替代外部模型；桌面、Host、stdio Runtime、存储和投影保持真实实现。 */
export async function startMemoryProviderFixture({ port = 0, record = async () => {} } = {}) {
  const state = {
    requests: [],
    predictionDelay: 0,
    readOnlyToolOnce: false,
    keyword: "RecordingFreedom",
    suggestion: "为 RecordingFreedom 补充测试说明",
    fileName: "recordingfreedom-testing.md",
    fact: "RecordingFreedom 的前端目录为 app/frontend，单元测试命令为 npm run test:unit，端到端测试命令为 npm run test:e2e。",
  };
  const memory = () =>
    `---\nname: RecordingFreedom 测试入口\ndescription: 项目前端测试目录和命令\ntype: project\n---\n\n${state.fact}\n`;
  function reply(body) {
    const messages = body.messages ?? [];
    const content = JSON.stringify(messages);
    if (content.includes("Predict one short message"))
      return { kind: "prediction", text: JSON.stringify({ suggestion: state.suggestion }) };
    if (content.includes("independent verifier for Project Memory")) {
      const evidence = JSON.parse(messages.at(-1).content);
      return {
        kind: "verification",
        text: JSON.stringify({
          decisions: evidence.items.map((item) => ({
            itemId: item.itemId,
            accept: true,
            reason: "Supported by the explicit synthetic project testing facts.",
            rankingEligible: false,
          })),
        }),
      };
    }
    if (content.includes("propose durable project memory changes")) {
      const evidence = JSON.parse(messages.at(-1).content);
      const source = evidence.sources.find(
        (s) => s.kind === "session" && s.content.includes(state.keyword),
      );
      const before = evidence.sources.find(
        (s) => s.kind === "memory" && s.reference === state.fileName,
      );
      const items =
        source && before?.content !== memory()
          ? [
              {
                fileName: state.fileName,
                content: memory(),
                reason: "Explicit stable project test entrypoints.",
                sourceIds: [source.id],
              },
            ]
          : [];
      return {
        kind: "learning",
        text: JSON.stringify({ summary: "Project testing facts", items }),
      };
    }
    if (state.readOnlyToolOnce && body.tools?.some((tool) => tool.function?.name === "Bash")) {
      state.readOnlyToolOnce = false;
      return {
        kind: "conversation",
        text: "",
        toolCalls: [
          {
            id: "call_native_git_status",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({
                command: "git status --porcelain=v1",
                timeout: 10000,
                description: "检查授权项目的现有 Git 状态",
              }),
            },
          },
        ],
      };
    }
    return {
      kind: "conversation",
      text:
        "已完成本轮确认。" + (content.includes("test:unit") ? state.fact : "本轮测试请求已完成。"),
    };
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "desktop-e2e", object: "model", owned_by: "local-validation" }],
          }),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const response = reply(body);
      const request = { at: Date.now(), url: req.url, kind: response.kind, body, cancelled: false };
      state.requests.push(request);
      res.once("close", () => {
        if (!res.writableFinished) request.cancelled = true;
      });
      await record(request);
      if (response.kind === "prediction" && state.predictionDelay) {
        const connected = await new Promise((resolve) => {
          const closed = () => {
            clearTimeout(timer);
            resolve(false);
          };
          const timer = setTimeout(() => {
            res.removeListener("close", closed);
            resolve(true);
          }, state.predictionDelay);
          res.once("close", closed);
        });
        if (!connected) return;
      }
      const id = `chatcmpl-electron-${state.requests.length}`;
      const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (delta, finish_reason = null) =>
          res.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "desktop-e2e", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        send({ role: "assistant" });
        if (response.toolCalls)
          send({ tool_calls: response.toolCalls.map((call, index) => ({ index, ...call })) });
        else send({ content: response.text });
        send({}, response.toolCalls ? "tool_calls" : "stop");
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "desktop-e2e",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: response.text,
                  ...(response.toolCalls ? { tool_calls: response.toolCalls } : {}),
                },
                finish_reason: response.toolCalls ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        );
      }
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    state,
    memory,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
