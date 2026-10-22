import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AuthDriver, AuthWireProtocol } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 真正的 Host 账号/票据/流生命周期；只有厂商 IO 是合成 driver。 */
export async function quotaRoutingFixture(
  t: TestContext,
  protocol: AuthWireProtocol = "anthropic-messages",
  count = 1,
) {
  let time = Date.parse("2026-10-22T04:00:00Z");
  t.mock.method(Date, "now", () => time);
  const directory = await mkdtemp(join(tmpdir(), "oauth-quota-refresh-"));
  const saved = new Map<string, string>();
  const posts: { id?: string; access?: unknown }[] = [];
  const tickets = new Map<string, { baseURL: string; apiKey: string }>();
  let quotaReads = 0;
  let readQuota: NonNullable<AuthDriver["quota"]> = async () => ({
    windows: [{ id: "short", name: "5 hours", used: 20 }],
  });
  const service = new ProviderAccounts({
    lockPath: join(directory, "accounts"),
    channels: [{ id: "commandcode-plan", name: "Fixture CommandCode" }],
    readRouting: async () => ({ version: 1, strategy: "reliable-first" }),
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    factory: async () => ({
      routingSingleAttempt: true,
      methods: async () => [{ id: "login", label: "Fixture", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async (code) => ({ type: "oauth", access: "fixture-only", accountId: code }),
      }),
      models: async () => [
        {
          id: "model",
          name: "Fixture",
          baseURL: "https://fixture.invalid/v1",
          protocol,
          routingPortability: "portable",
        },
      ],
      quota: async (context) => {
        quotaReads++;
        return readQuota(context);
      },
      fetch: async (_request, context) => {
        posts.push({ id: context.connectionId, access: (await context.read())?.access });
        return new Response("fixture");
      },
    }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const attempt = await service.startAuthorization({
      channelId: "commandcode-plan",
      methodId: "login",
    });
    const completed = await service.completeAuthorization(attempt.attemptId, String(i));
    ids.push(completed.connectionId!);
  }
  const suffix =
    protocol === "anthropic-messages"
      ? "/messages"
      : protocol === "openai-responses"
        ? "/responses"
        : "/chat/completions";
  async function send(attemptId: string, signal?: AbortSignal) {
    const auth = await service.resolveRequestAuth(
      "commandcode-plan",
      "model",
      protocol,
      "session",
      {
        capability: "single-attempt-routing-v1",
        workspaceKey: "fixture-workspace",
        sessionId: "session",
        turnId: attemptId,
        attemptId,
      },
    );
    tickets.set(attemptId, auth);
    const response = await fetch(auth.baseURL + suffix, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
      signal,
    });
    await response.text();
    return response;
  }
  return {
    service,
    ids,
    posts,
    tickets,
    send,
    suffix,
    get quotaReads() {
      return quotaReads;
    },
    advance: (ms: number) => {
      time += ms;
    },
    setQuota: (next: typeof readQuota) => {
      readQuota = next;
    },
  };
}
