import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  NodePersonalProviderConfigRepository,
  decodeProviderConfigFile,
} from "@lcode/provider-node";
import { acquireFileLock } from "@lcode/shared/node";
import { createGitBackupService } from "./gitBackupService.js";
import {
  ProviderAccounts,
  getProviderAccountBackupPort,
} from "../model-provider/providerAccounts.js";
import { createProviderBackupSource } from "../model-provider/providerBackupSource.js";
const secret = "fixture-network-secret";
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
function verifySignature(
  method: string,
  url: URL,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
) {
  const authorization = String(headers.authorization);
  const scope = authorization.match(/Credential=fixture-id\/([^,]+)/)?.[1];
  const signed = authorization.match(/SignedHeaders=([^,]+)/)?.[1];
  const signature = authorization.match(/Signature=(\w+)/)?.[1];
  assert.ok(scope && signed && signature);
  const payload = createHash("sha256").update(body).digest("hex");
  assert.equal(headers["x-amz-content-sha256"], payload);
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => a!.localeCompare(b!) || av!.localeCompare(bv!))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [
    method,
    url.pathname,
    canonicalQuery,
    signed
      .split(";")
      .map((key) => `${key}:${String(headers[key]).trim()}\n`)
      .join(""),
    signed,
    payload,
  ].join("\n");
  const date = String(headers["x-amz-date"]);
  const [day, region] = scope.split("/");
  const hmac = (key: string | Buffer, data: string) =>
    createHmac("sha256", key).update(data).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day!), region!), "s3"), "aws4_request");
  const expected = createHmac("sha256", key)
    .update(
      ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join(
        "\n",
      ),
    )
    .digest("hex");
  assert.equal(signature, expected);
}
test(
  "real HTTP signed storage supports cross-profile recovery, deduplication, scheduler and retention",
  { timeout: 60_000 },
  async (t) => {
    const objects = new Map<string, Buffer>();
    let puts = 0;
    const serverErrors: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const url = new URL(request.url!, `http://${request.headers.host}`);
        verifySignature(request.method!, url, request.headers, body);
        const objectKey = decodeURIComponent(url.pathname.slice("/fixture-bucket/".length));
        if (request.method === "PUT") {
          puts++;
          objects.set(objectKey, body);
          response.writeHead(200).end();
          return;
        }
        if (request.method === "DELETE") {
          objects.delete(objectKey);
          response.writeHead(204).end();
          return;
        }
        if (url.searchParams.has("prefix")) {
          const all = [...objects.keys()]
            .filter((key) => key.startsWith(url.searchParams.get("prefix")!))
            .sort();
          const offset = Number(url.searchParams.get("continuation-token") ?? 0);
          const keys = all.slice(offset, offset + 2);
          const truncated = offset + 2 < all.length;
          response
            .writeHead(200, { "Content-Type": "application/xml" })
            .end(
              `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join("")}${truncated ? `<NextContinuationToken>${offset + 2}</NextContinuationToken>` : ""}</ListBucketResult>`,
            );
          return;
        }
        const data = objects.get(objectKey);
        response.writeHead(data ? 200 : 404).end(data);
      })().catch((error) => {
        serverErrors.push(error);
        response.writeHead(500).end("fixture error");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.close();
      await once(server, "close");
    });
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = await mkdtemp(join(tmpdir(), "backup-network-"));
    let now = Date.now();
    const profiles: Awaited<ReturnType<typeof profile>>[] = [];
    async function profile(name: string) {
      const directory = join(root, name);
      await mkdir(directory);
      const repository = new NodePersonalProviderConfigRepository({
        filePath: join(directory, "personal.json"),
        pollingIntervalMs: false,
      });
      const values = new Map<string, string>();
      const credentials = {
        load: async (key: string) => values.get(key) ?? null,
        save: async (key: string, value: string) => {
          values.set(key, value);
        },
        delete: async (key: string) => {
          values.delete(key);
        },
      };
      const accounts = new ProviderAccounts({
        credentials,
        lockPath: join(directory, "accounts"),
        channels: [],
      });
      const source = createProviderBackupSource({
        profileDir: directory,
        personalFilePath: join(directory, "personal.json"),
        personalRepository: repository,
        accounts: getProviderAccountBackupPort(accounts),
        credentials,
        refresh: async () => {},
      });
      await source.ready;
      const backupDir = join(directory, "git-backup");
      const service = createGitBackupService(backupDir, {
        credentialService: credentials,
        providerBackupSource: source.port,
        now: () => now,
        schedulerPollMs: 10,
      });
      await service.configure({
        minio: {
          endpoint,
          accessKeyId: "fixture-id",
          accessKeySecret: secret,
          bucket: "fixture-bucket",
          region: "us-east-1",
          pathPrefix: "migration",
        },
        destinationEnabled: { minio: true },
      });
      return { repository, source, service, accounts, backupDir };
    }
    t.after(async () => {
      for (const p of profiles) {
        p.service.dispose();
        const release = await acquireFileLock(
          join(p.backupDir, "git-backup-execution"),
          [10, 25],
          100,
          5000,
        );
        await release();
        p.repository.dispose();
        await p.accounts.dispose();
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const old = await profile("old");
    profiles.push(old);
    const fresh = await profile("fresh");
    profiles.push(fresh);
    const config = (apiKey: string) =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture-provider",
                providerName: "Fixture",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey },
                  api: { type: "openai-chat-completions", baseUrl: "https://fixture.invalid/v1" },
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      });
    await old.repository.update(() => config("fixture-key-one"));
    const first = await old.service.backupNow!({
      kind: "providers",
      locations: ["minio"],
      operationId: "first",
    });
    assert.equal(first.results[0]!.status, "created");
    const initialPuts = puts;
    const unchanged = await old.service.backupNow!({
      kind: "providers",
      locations: ["minio"],
      operationId: "same",
    });
    assert.equal(unchanged.results[0]!.status, "skipped-unchanged");
    assert.equal(puts, initialPuts);
    const kit = await old.service.exportRecoveryKit!("fixture-password");
    await fresh.service.importRecoveryKit!(kit, "fixture-password");
    const versions = await fresh.service.listBackups!("minio", "providers");
    assert.equal(versions.length, 1);
    const plan = await fresh.service.planBackupRestore!({
      id: versions[0]!.id,
      location: "minio",
      locationRevision: versions[0]!.locationRevision,
      mode: "merge",
    });
    await fresh.service.commitBackupRestore!(plan.planId, "restore");
    assert.deepEqual(
      (await fresh.source.port.capture()).data,
      (await old.source.port.capture()).data,
    );
    const state = await old.service.getBackupState!();
    await old.service.configureBackupPolicy!(
      {
        localEnabled: state.policy.localEnabled,
        localDirectory: state.policy.localDirectory,
        retention: { local: 1, oss: 1, minio: 1 },
        providers: { enabled: true, intervalMinutes: 5, selection: null, locations: ["minio"] },
      },
      state.policy.revision,
    );
    await old.repository.update(() => config("fixture-key-two"));
    now += 300_001;
    for (let i = 0; i < 500; i++) {
      const current = await old.service.getBackupState!();
      if (
        current.lastResult?.operationId !== "same" &&
        Date.parse(current.nextProviderCheckAt ?? "") > now
      )
        break;
      await sleep(10);
    }
    const after = await old.service.listBackups!("minio", "providers");
    assert.equal(after.length, 1);
    assert.notEqual(after[0]!.id, versions[0]!.id);
    const checkpoint = puts;
    now += 300_001;
    for (let i = 0; i < 500; i++) {
      const current = await old.service.getBackupState!();
      if (Date.parse(current.nextProviderCheckAt ?? "") > now) break;
      await sleep(10);
    }
    assert.equal(puts, checkpoint);
    assert.deepEqual(serverErrors, []);
  },
);
