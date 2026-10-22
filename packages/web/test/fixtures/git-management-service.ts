import type { IGitManagementService } from "@lcode/services";
import {
  gitManagementMutationSchema,
  type GitManagementSnapshot,
  type GitAccountInput,
  type GitDetectedAccount,
  type GitAuthorizationStatus,
  type GitAuthorizationCommand,
} from "@lcode/shared";
let snapshot: GitManagementSnapshot = {
  revision: "empty",
  configuration: { binaryPath: "", userName: "", userEmail: "", initialBranch: "main" },
  accounts: [],
};
const tokens = new Map<string, string>();
const routingBindings = new Map<string, string>();
let heldAuthentication: Promise<void> | null = null,
  releaseAuthentication: (() => void) | null = null;
let usernameHint: string | undefined;
const routingCalls: unknown[] = [];
const authorizations = new Map<
  string,
  { input: Extract<GitAuthorizationCommand, { type: "start" }>; status: GitAuthorizationStatus }
>();
let conflict = false;
let detectionFailure = false;
let releaseDetection: (() => void) | null = null;
let detectionGate: Promise<void> | null = null;
const detected: GitDetectedAccount[] = [
  ...["alice", "bob"].map((username) => ({
    candidateId: "gcm-" + username,
    source: "Git Credential Manager",
    name: username + " · github.com",
    provider: "github" as const,
    serverUrl: "https://github.com",
    username,
    auth: "system" as const,
    privateKeyPath: "",
    canImport: true,
  })),
  {
    candidateId: "lab-fixture",
    source: "gitlab CLI",
    name: "自建 GitLab",
    provider: "gitlab",
    serverUrl: "https://gitlab.example.invalid",
    username: "lab",
    auth: "system",
    privateKeyPath: "",
    canImport: true,
  },
  {
    candidateId: "forge-fixture",
    source: "tea CLI",
    name: "Forgejo 本机",
    provider: "gitea",
    serverUrl: "https://forgejo.example.invalid",
    username: "forge",
    auth: "system",
    privateKeyPath: "",
    canImport: true,
  },
  {
    candidateId: "ssh-fixture",
    source: "SSH config",
    name: "SSH 工作账号",
    provider: "server",
    serverUrl: "ssh://git@work-git",
    username: "git",
    auth: "ssh",
    privateKeyPath: "/fixture/.ssh/id_ed25519",
    canImport: true,
  },
];
if (new URLSearchParams(location.search).has("systems")) {
  for (const [provider, serverUrl, username] of [
    ["gitlab", "https://gitlab.example.invalid", "lab-second"],
    ["gitlab", "https://code.example.invalid:8443/team", "internal"],
    ["gitea", "https://forgejo.example.invalid", "forge-second"],
    ["server", "https://bitbucket.org", "bb-first"],
    ["server", "https://bitbucket.org", "bb-second"],
  ] as const)
    detected.push({
      candidateId: "system-" + username,
      source: "windows-credentials",
      name: username,
      provider,
      serverUrl,
      username,
      auth: "system",
      privateKeyPath: "",
      canImport: true,
    });
}
let systemUnavailable = false;
export const gitManagementControls = {
  usernameHint: (value: string) => {
    usernameHint = value;
  },
  routingCalls: () => structuredClone(routingCalls),
  holdNextAuthentication: () => {
    heldAuthentication = new Promise<void>((done) => {
      releaseAuthentication = done;
    });
  },
  releaseAuthentication: () => {
    releaseAuthentication?.();
    releaseAuthentication = null;
  },
  failAuthorization: (error: GitAuthorizationStatus["error"]) => {
    for (const attempt of authorizations.values())
      if (attempt.status.status === "pending")
        attempt.status = { ...attempt.status, status: "failed", error };
  },
  systemUnavailable: () => {
    systemUnavailable = true;
  },
  completeAuthorization: () => {
    for (const attempt of authorizations.values())
      if (attempt.status.status === "pending")
        attempt.status = { ...attempt.status, status: "ready", username: "authorized-fixture" };
  },
  snapshot: () => structuredClone(snapshot),
  conflict: () => {
    conflict = true;
  },
  failDetection: () => {
    detectionFailure = true;
  },
  holdDetection: () => {
    detectionGate = new Promise((resolve) => {
      releaseDetection = resolve;
    });
  },
  releaseDetection: () => {
    releaseDetection?.();
    detectionGate = null;
    releaseDetection = null;
  },
};
export const gitManagementService: IGitManagementService = {
  async authorize(command) {
    if (command.type === "start") {
      const status: GitAuthorizationStatus = {
        requestId: command.requestId,
        status: "pending",
        expiresAt: Date.now() + 600000,
        pollAfterMs: 1000,
        authorizeUrl: new URL("/authorize", command.serverUrl).href,
        ...(command.provider === "github" ? { userCode: "ABCD-EFGH" } : {}),
      };
      authorizations.set(command.requestId, { input: command, status });
      return status;
    }
    const attempt = authorizations.get(command.requestId);
    if (!attempt) throw new Error("oauth-invalid");
    if (command.type === "cancel") attempt.status = { ...attempt.status, status: "cancelled" };
    const { authorizeUrl, userCode, ...status } = attempt.status;
    return structuredClone({
      ...status,
      ...(status.status === "pending" ? { authorizeUrl, userCode } : {}),
    });
  },
  async getSnapshot() {
    return structuredClone(snapshot);
  },
  async getRepositoryAuthentication(request) {
    routingCalls.push({ type: "get", ...request });
    const scope = request.workspaceIdentity || request.workspacePath;
    const choices = [
      ...snapshot.accounts.map((account) => ({
        key: `saved:${account.id}:${account.revision}`,
        ...account,
      })),
      ...detected
        .filter(
          (candidate) =>
            !snapshot.accounts.some(
              (account) =>
                account.serverUrl === candidate.serverUrl &&
                account.username === candidate.username &&
                account.auth === candidate.auth,
            ),
        )
        .map((account) => ({ key: `detected:${account.candidateId}`, ...account })),
    ].map(({ key, name, username, serverUrl, auth, provider }) => ({
      key,
      name,
      username,
      serverUrl,
      auth,
      provider,
    }));
    const remotes = [
      {
        name: "origin",
        urls: ["https://github.com/fixture/repo.git", "https://github.com/fixture/publish.git"],
      },
      { name: "fork", urls: ["https://github.com/fixture/fork.git"] },
    ].map((remote) => ({
      ...remote,
      urls: remote.urls.map((url) => {
        const selection = routingBindings.get(scope + "|" + url) ?? null;
        return {
          url,
          selection,
          ...(usernameHint ? { usernameHint } : {}),
          stale: Boolean(selection && !choices.some((c) => c.key === selection)),
        };
      }),
    }));
    const result = { revision: snapshot.revision, choices, remotes };
    const gate = heldAuthentication;
    heldAuthentication = null;
    await gate;
    return structuredClone(result);
  },
  async bindRepositoryAuthentication(request) {
    routingCalls.push({ type: "bind", ...request });
    if (request.expectedRevision !== snapshot.revision)
      throw new Error("git-account-binding-conflict");
    let selection = request.selection;
    if (selection?.startsWith("detected:")) {
      const candidate = detected.find((c) => c.candidateId === selection!.slice(9))!;
      await gitManagementService.mutate({
        type: "import",
        candidateId: candidate.candidateId,
        expectedRevision: snapshot.revision,
      });
      const account = snapshot.accounts.find(
        (a) => a.username === candidate.username && a.serverUrl === candidate.serverUrl,
      )!;
      selection = `saved:${account.id}:${account.revision}`;
    }
    const key = (request.workspaceIdentity || request.workspacePath) + "|" + request.url;
    if (selection) routingBindings.set(key, selection);
    else routingBindings.delete(key);
    snapshot = { ...snapshot, revision: crypto.randomUUID() };
    return gitManagementService.getRepositoryAuthentication!(request);
  },
  async mutate(input) {
    const request = gitManagementMutationSchema.parse(input);
    if (conflict) {
      conflict = false;
      snapshot = { ...snapshot, revision: crypto.randomUUID() };
      throw new Error("revision-conflict");
    }
    if (request.expectedRevision !== snapshot.revision) throw new Error("revision-conflict");
    if (request.type === "authorize") {
      const attempt = authorizations.get(request.requestId);
      if (attempt?.status.status !== "ready") throw new Error("oauth-invalid");
      const id = request.accountId ?? crypto.randomUUID();
      snapshot = {
        ...snapshot,
        accounts: [
          ...snapshot.accounts.filter((a) => a.id !== id),
          {
            id,
            revision: crypto.randomUUID(),
            name: request.name,
            provider: attempt.input.provider,
            serverUrl: attempt.input.serverUrl,
            username: attempt.status.username!,
            auth: "oauth",
            privateKeyPath: "",
            hasToken: true,
          },
        ],
      };
      attempt.status = { ...attempt.status, status: "saved", accountId: id };
    } else if (request.type === "configuration")
      snapshot = { ...snapshot, configuration: request.configuration };
    else if (request.type === "delete") {
      tokens.delete(request.id);
      snapshot = { ...snapshot, accounts: snapshot.accounts.filter((a) => a.id !== request.id) };
    } else {
      const account: GitAccountInput =
        request.type === "save"
          ? request.account
          : (() => {
              const candidate = detected.find((a) => a.candidateId === request.candidateId);
              if (!candidate) throw new Error("detected-account-changed");
              const {
                candidateId: _candidateId,
                source: _source,
                canImport: _canImport,
                ...account
              } = candidate;
              return account;
            })();
      const id = account.id ?? crypto.randomUUID();
      if (account.token) tokens.set(id, account.token);
      const { token: _token, ...data } = account;
      snapshot = {
        ...snapshot,
        accounts: [
          ...snapshot.accounts.filter((a) => a.id !== id),
          { ...data, id, revision: crypto.randomUUID(), hasToken: tokens.has(id) },
        ],
      };
    }
    snapshot = { ...snapshot, revision: crypto.randomUUID() };
    return structuredClone(snapshot);
  },
  async detect() {
    await detectionGate;
    if (detectionFailure) {
      detectionFailure = false;
      throw new Error("fixture-detection-failure");
    }
    return {
      binaryPath: "/fixture/bin/git",
      sshDirectory: "/fixture/.ssh",
      privateKeyPaths: ["/fixture/.ssh/id_ed25519", "/fixture/.ssh/id_missing"],
      sshKeys: [
        {
          privateKeyPath: "/fixture/.ssh/id_ed25519",
          publicKeyPath: "/fixture/.ssh/id_ed25519.pub",
          keyType: "ssh-ed25519",
          fingerprint: "SHA256:fixture-public-fingerprint",
          publicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH fixture@example.invalid",
        },
      ],
      systemCredentialSources: [
        {
          source: "windows-credentials",
          status: systemUnavailable ? "unavailable" : "ok",
          accountCount: systemUnavailable ? 0 : 5,
        },
      ],
      warnings: [],
      accounts: structuredClone(
        detected.filter(
          (account) => !systemUnavailable || account.source !== "windows-credentials",
        ),
      ),
    };
  },
};
