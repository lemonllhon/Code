import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "@lcode/shared/node";
import {
  createProviderNetworkTransport,
  type ProviderNetworkOptions,
} from "@lcode/provider-node/network";
import {
  gitAccountSchema,
  gitAccountInputSchema,
  gitConfigurationSchema,
  gitManagementMutationSchema,
  gitManagementSnapshotSchema,
  gitManagementDetectionSchema,
  type GitAuthenticationReference,
  type GitManagementSnapshot,
} from "@lcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IGitManagementService } from "./contract.js";
import { detectGitAccounts } from "./gitDetection.js";
import { createGitEnvironmentProvider } from "../git/providers/gitEnvironmentProvider.js";
import { getAppConfigDir } from "../paths.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../git/providers/gitCommandProvider.js";
import {
  runGitCredentialMetadata,
  type GitCredentialMetadataRunner,
} from "./gitCredentialMetadataProcess.js";
import { createGitAccountAuthorization } from "./gitAccountAuthorization.js";
import { createGitAccountRouting, gitStoredAccountBindingSchema } from "./gitAccountRouting.js";
import { projectGitRepositoryContext } from "./gitRepositoryContext.js";
import {
  gitOAuthGrantSchema,
  refreshGitOAuthGrant,
  type GitOAuthFetch,
} from "./gitOAuthTransport.js";

const key = "git-management:v1";
const storedAccount = gitAccountSchema
  .omit({ hasToken: true })
  .extend({ token: z.string().optional(), oauth: gitOAuthGrantSchema.optional() })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    revision: z.string(),
    configuration: gitConfigurationSchema,
    accounts: z.array(storedAccount).max(200),
    bindings: z.array(gitStoredAccountBindingSchema).max(2000).default([]),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;
export type GitManagementOwner = IGitManagementService & {
  dispose(): void;
  authentication(
    url: string,
    reference?: Pick<GitAuthenticationReference, "id"> &
      Partial<Pick<GitAuthenticationReference, "revision">>,
  ): Promise<{ account: Store["accounts"][number] | null; secret?: string }>;
  configuration(): Promise<Store["configuration"]>;
  resolveRepositoryAuthentication: ReturnType<typeof createGitAccountRouting>["resolve"];
  repositoryCredential: ReturnType<typeof createGitAccountRouting>["credential"];
  readRepositoryContext(
    request: import("@lcode/shared").GitRepositoryAuthenticationRequest,
  ): Promise<import("@lcode/shared").GitAgentRepositoryContext>;
};
export function createGitManagementService(options: {
  credentials: ICredentialService;
  home?: string;
  lockPath?: string;
  configHome?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  detectionCommand?: GitCommandProvider | null;
  credentialMetadataRunner?: GitCredentialMetadataRunner | null;
  oauthHttp?: GitOAuthFetch;
  oauthNetworkOptions?: () => Promise<ProviderNetworkOptions>;
}): GitManagementOwner {
  const home = options.home ?? homedir(),
    lockPath = options.lockPath ?? join(getAppConfigDir(), "git-management");
  // 中文依据：OAuth 不能使用裸 fetch 绕过 Host 已配置的 CA/代理；交换和刷新共享同一受控连接 owner。
  const oauthNetwork = options.oauthHttp
    ? null
    : createProviderNetworkTransport(async () => ({
        ...(await options.oauthNetworkOptions?.()),
        useSystemCa: true,
      }));
  const oauthHttp = options.oauthHttp ?? oauthNetwork!.fetch;
  const authorization = createGitAccountAuthorization({ http: oauthHttp });
  const read = async (): Promise<Store> => {
    const raw = await options.credentials.load(key);
    if (raw === null)
      return {
        version: 1,
        revision: "empty",
        configuration: { binaryPath: "", userName: "", userEmail: "", initialBranch: "main" },
        accounts: [],
        bindings: [],
      };
    // 损坏或未知版本不能当空配置覆盖，否则会丢失其他窗口保存的账号。
    try {
      return storeSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("git-management-corrupt");
    }
  };
  const snapshot = (data: Store): GitManagementSnapshot =>
    gitManagementSnapshotSchema.parse({
      revision: data.revision,
      configuration: data.configuration,
      accounts: data.accounts.map(({ token, oauth: _oauth, ...account }) => ({
        ...account,
        hasToken: Boolean(token),
      })),
    });
  const detectionCommand =
    options.detectionCommand === undefined
      ? createGitCommandProvider({
          environmentProvider: createGitEnvironmentProvider({
            configuredBinary: async () => (await read()).configuration.binaryPath,
          }),
        })
      : options.detectionCommand;
  const detect = async () =>
    detectGitAccounts(
      home,
      options.configHome,
      options.environment ?? (options.home ? {} : process.env),
      {
        platform: options.platform,
        command: detectionCommand,
        metadataRunner:
          options.credentialMetadataRunner === undefined
            ? runGitCredentialMetadata
            : options.credentialMetadataRunner,
        evidence: (await read()).accounts.map((a) => ({
          serverUrl: a.serverUrl,
          provider: a.provider,
        })),
      },
    );
  const routing = createGitAccountRouting({
    read,
    detect,
    command: createGitCommandProvider({
      environmentProvider: createGitEnvironmentProvider({
        configuredBinary: async () => (await read()).configuration.binaryPath,
      }),
    }),
    authenticate: (url, reference) => owner.authentication(url, reference),
    update: (expected, edit) =>
      withFileLock(lockPath, async () => {
        const data = await read();
        if (data.revision !== expected) throw new Error("git-account-binding-conflict");
        edit(data);
        data.revision = randomUUID();
        await options.credentials.save(key, JSON.stringify(storeSchema.parse(data)));
      }),
  });
  const owner: GitManagementOwner = {
    getRepositoryAuthentication: routing.getRepositoryAuthentication,
    bindRepositoryAuthentication: routing.bindRepositoryAuthentication,
    resolveRepositoryAuthentication: routing.resolve,
    repositoryCredential: routing.credential,
    readRepositoryContext: async (request) =>
      projectGitRepositoryContext(
        request.workspacePath,
        await routing.getRepositoryAuthentication(request),
      ),
    dispose: () => {
      authorization.dispose();
      oauthNetwork?.dispose();
    },
    authorize: authorization.command,
    async getSnapshot() {
      return snapshot(await read());
    },
    async configuration() {
      return (await read()).configuration;
    },
    async detect() {
      const result = await detect();
      const binaryPath = await createGitEnvironmentProvider().resolveGitBinary();
      return gitManagementDetectionSchema.parse({
        binaryPath,
        accounts: result.entries.map((e) => e.metadata),
        sshDirectory: result.sshDirectory,
        privateKeyPaths: result.privateKeyPaths,
        sshKeys: result.sshKeys,
        systemCredentialSources: result.systemCredentialSources,
        warnings: result.warnings,
      });
    },
    async mutate(input) {
      const request = gitManagementMutationSchema.parse(input);
      return withFileLock(lockPath, async () => {
        const data = await read();
        if (data.revision !== request.expectedRevision) throw new Error("revision-conflict");
        if (request.type === "authorize") {
          const grant = authorization.beginSave(request.requestId);
          try {
            if (request.accountId && !data.accounts.some((a) => a.id === request.accountId))
              throw new Error("missing-account");
            const id = request.accountId ?? randomUUID();
            const next = storedAccount.parse({
              id,
              revision: randomUUID(),
              name: request.name,
              provider: grant.provider,
              serverUrl: grant.serverUrl,
              username: grant.username,
              auth: "oauth",
              privateKeyPath: "",
              token: grant.accessToken,
              oauth: grant,
            });
            data.accounts = [...data.accounts.filter((a) => a.id !== id), next];
            data.revision = randomUUID();
            await options.credentials.save(key, JSON.stringify(storeSchema.parse(data)));
            authorization.finishSave(request.requestId, id);
            return snapshot(data);
          } catch (error) {
            authorization.rollbackSave(request.requestId);
            throw error;
          }
        }
        if (request.type === "configuration") data.configuration = request.configuration;
        else if (request.type === "delete") {
          if (!data.accounts.some((a) => a.id === request.id)) throw new Error("missing-account");
          data.accounts = data.accounts.filter((a) => a.id !== request.id);
        } else {
          const imported =
            request.type === "import"
              ? (await detect()).entries.find((e) => e.metadata.candidateId === request.candidateId)
              : null;
          if (request.type === "import" && !imported) throw new Error("detected-account-changed");
          const account = gitAccountInputSchema.parse(
            request.type === "save" ? request.account : imported!.account,
          );
          if (
            request.type === "import" &&
            // 中文依据：同名令牌账号不能吞掉直接选用的系统账号；幂等身份必须包含认证方式。
            data.accounts.some(
              (a) =>
                a.serverUrl === account.serverUrl &&
                a.username === account.username &&
                a.auth === account.auth &&
                a.privateKeyPath === account.privateKeyPath,
            )
          )
            return snapshot(data);
          const original = account.id ? data.accounts.find((a) => a.id === account.id) : null;
          if (account.id && !original) throw new Error("missing-account");
          if (
            account.auth === "oauth" &&
            (!original?.oauth ||
              original.serverUrl !== account.serverUrl ||
              original.username !== account.username ||
              original.provider !== account.provider)
          )
            throw new Error("oauth-invalid");
          const token =
            account.auth === "token"
              ? account.token || original?.token
              : account.auth === "oauth"
                ? original?.token
                : undefined;
          if (account.auth === "token" && !token) throw new Error("token-required");
          const id = account.id ?? randomUUID();
          // 地址或用户名变化时，留空令牌不能把原服务器的秘密带到新服务器。
          if (
            original?.token &&
            !account.token &&
            (account.serverUrl !== original.serverUrl || account.username !== original.username) &&
            account.auth === "token"
          )
            throw new Error("token-required-after-server-change");
          const next = storedAccount.parse({
            ...account,
            id,
            revision: randomUUID(),
            token,
            ...(account.auth === "oauth" ? { oauth: original?.oauth } : {}),
          });
          data.accounts = [...data.accounts.filter((a) => a.id !== id), next];
        }
        data.revision = randomUUID();
        const validated = storeSchema.parse(data);
        await options.credentials.save(key, JSON.stringify(validated));
        return snapshot(validated);
      });
    },
    async authentication(url, reference) {
      if (!reference) return { account: null };
      const data = await read(),
        account = data.accounts.find((a) => a.id === reference.id);
      if (!account) throw new Error("missing-account");
      if (reference.revision && reference.revision !== account.revision)
        throw new Error("stale-account");
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        const scp = url.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
        if (!scp) throw new Error("account-server-mismatch");
        target = new URL(
          `ssh://${scp[1] ? encodeURIComponent(scp[1]) + "@" : ""}${scp[2]}/${scp[3]}`,
        );
      }
      const server = new URL(account.serverUrl),
        prefix = server.pathname.replace(/\/$/, "");
      if (
        target.protocol !== server.protocol ||
        target.host.toLowerCase() !== server.host.toLowerCase() ||
        target.password ||
        target.search ||
        target.hash ||
        !(target.pathname === prefix || target.pathname.startsWith(prefix + "/")) ||
        (target.username && decodeURIComponent(target.username) !== account.username)
      )
        throw new Error("account-server-mismatch");
      if (account.auth === "oauth")
        return withFileLock(lockPath, async () => {
          const latest = await read(),
            current = latest.accounts.find((a) => a.id === account.id);
          if (!current || current.revision !== account.revision || !current.oauth)
            throw new Error("stale-account");
          if (current.oauth.expiresAt && current.oauth.expiresAt <= Date.now() + 30000) {
            try {
              const refreshed = await refreshGitOAuthGrant(oauthHttp, current.oauth);
              current.oauth = refreshed;
              current.token = refreshed.accessToken;
              await options.credentials.save(key, JSON.stringify(storeSchema.parse(latest)));
            } catch {
              throw new Error("oauth-expired");
            }
          }
          return { account: current, secret: current.token };
        });
      return { account, secret: account.auth === "token" ? account.token : undefined };
    },
  };
  return owner;
}
