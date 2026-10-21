import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, GitBranch, KeyRound } from "lucide-react";
import type { GitAccountInput, GitAccount, GitConfiguration } from "@lcode/shared";
import { gitAccountInputSchema, gitConfigurationSchema } from "@lcode/shared";
import { useGitManagement } from "@/hooks/useGitManagement.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { GitAccountEditor } from "./GitAccountEditor.js";
import { GitSshKeyList } from "./GitSshKeyList.js";
import { GitDetectedAccountList } from "./GitDetectedAccountList.js";
import { GitBinaryPathControl } from "./GitBinaryPathControl.js";

export function GitManagementSection() {
  const management = useGitManagement({ autoDetect: true }),
    { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  const [provider, setProvider] = useState<GitAccount["provider"]>("github"),
    [draft, setDraft] = useState<GitAccountInput | null>(null),
    [deleteId, setDeleteId] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<GitConfiguration | null>(null),
    [invalid, setInvalid] = useState(false);
  const [authorizationRequestId, setAuthorizationRequestId] = useState<string | null>(null);
  const snapshot = management.snapshot;
  useEffect(() => {
    if (snapshot) setConfiguration(snapshot.configuration);
    // 账号与 Git 配置是独立编辑区；账号保存只更新快照 revision，不能清掉尚未保存的 Git 字段。
  }, [
    snapshot?.configuration.binaryPath,
    snapshot?.configuration.userName,
    snapshot?.configuration.userEmail,
    snapshot?.configuration.initialBranch,
  ]);
  const start = (account?: GitAccount) => {
    setAuthorizationRequestId(null);
    setInvalid(false);
    setDeleteId(null);
    setDraft(
      account
        ? {
            id: account.id,
            name: account.name,
            provider: account.provider,
            serverUrl: account.serverUrl,
            username: account.username,
            auth: account.auth,
            privateKeyPath: account.privateKeyPath,
            token: "",
          }
        : {
            name: "",
            provider,
            serverUrl:
              provider === "github"
                ? "https://github.com"
                : provider === "gitlab"
                  ? "https://gitlab.com"
                  : "https://",
            username: "",
            auth: "token",
            privateKeyPath: "",
            token: "",
          },
    );
  };
  const save = async () => {
    if (!draft || !snapshot) return;
    if (draft.auth === "oauth" && authorizationRequestId) {
      const name = draft.name.trim() || `${draft.username} · ${new URL(draft.serverUrl).host}`;
      if (
        await management.mutate({
          type: "authorize",
          expectedRevision: snapshot.revision,
          requestId: authorizationRequestId,
          name,
          accountId: draft.id,
        })
      ) {
        setDraft(null);
        setAuthorizationRequestId(null);
        setProvider(draft.provider);
      }
      return;
    }
    const parsed = gitAccountInputSchema.safeParse(draft);
    setInvalid(!parsed.success);
    if (
      parsed.success &&
      (await management.mutate({
        type: "save",
        expectedRevision: snapshot.revision,
        account: parsed.data,
      }))
    ) {
      setDraft(null);
      setProvider(parsed.data.provider);
    }
  };
  const fields: [keyof Omit<GitConfiguration, "binaryPath">, string][] = [
    ["userName", "@min-[32rem]/git-configuration:w-48"],
    ["userEmail", "@min-[32rem]/git-configuration:w-72"],
    ["initialBranch", "@min-[32rem]/git-configuration:w-40"],
  ];
  const detectedAccounts =
    management.detection?.accounts.filter(
      (candidate) =>
        !snapshot?.accounts.some(
          (account) =>
            account.provider === candidate.provider &&
            account.serverUrl === candidate.serverUrl &&
            account.username === candidate.username &&
            account.privateKeyPath === candidate.privateKeyPath,
        ),
    ) ?? [];
  const candidates = detectedAccounts.filter((candidate) => candidate.provider === provider);
  if (!management.available)
    return <p className="text-ui-base text-foreground-subtle">{t("unavailable")}</p>;
  return (
    <div
      className="mx-auto w-full max-w-4xl space-y-6"
      data-testid="git-management-section"
      aria-busy={management.pending}
    >
      <section className="@container/git-configuration space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-ui-lg font-medium">
          <GitBranch className="size-4" />
          {t("configuration")}
        </h3>
        <GitBinaryPathControl
          value={configuration?.binaryPath ?? ""}
          detectedPath={management.detection?.binaryPath ?? null}
          disabled={!configuration || management.pending}
          detecting={management.detecting}
          onChange={(binaryPath) => setConfiguration((c) => c && { ...c, binaryPath })}
          onDetect={() => void management.detect()}
        />
        <div className="flex flex-wrap items-end gap-4">
          {fields.map(([key, width]) => (
            <label key={key} className={`flex w-full min-w-0 flex-col gap-2 text-ui-base ${width}`}>
              <span>{t(key)}</span>
              <Input
                aria-label={t(key)}
                disabled={!configuration || management.pending}
                value={configuration?.[key] ?? ""}
                placeholder={key === "initialBranch" ? "main" : t("existingGitValue")}
                onChange={(e) => setConfiguration((c) => c && { ...c, [key]: e.target.value })}
              />
            </label>
          ))}
          <Button
            size="sm"
            className="min-h-7"
            disabled={
              !snapshot ||
              management.pending ||
              !gitConfigurationSchema.safeParse(configuration).success
            }
            onClick={() => {
              if (configuration && snapshot)
                void management.mutate({
                  type: "configuration",
                  expectedRevision: snapshot.revision,
                  configuration,
                });
            }}
          >
            {t("saveConfiguration")}
          </Button>
        </div>
      </section>
      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-ui-lg font-medium">{t("accounts")}</h3>
          <Button
            size="sm"
            variant="outline"
            disabled={!snapshot || management.pending}
            onClick={() => start()}
          >
            <Plus className="size-4" />
            {t("addAccount")}
          </Button>
        </div>
        <div
          role="tablist"
          aria-label={t("accounts")}
          className="flex flex-wrap gap-1 border-b border-border pb-2"
        >
          {(["github", "gitlab", "gitea", "server"] as const).map((key) => (
            <Button
              key={key}
              role="tab"
              aria-label={t(key)}
              aria-selected={key === provider}
              size="sm"
              variant={key === provider ? "secondary" : "ghost"}
              disabled={Boolean(draft) || management.pending}
              onClick={() => {
                setProvider(key);
                setDeleteId(null);
              }}
            >
              {t(key)}
              {(snapshot?.accounts.filter((a) => a.provider === key).length ?? 0) +
                detectedAccounts.filter((a) => a.provider === key).length >
              0 ? (
                <span className="text-ui-sm tabular-nums text-foreground-subtle">
                  {(snapshot?.accounts.filter((a) => a.provider === key).length ?? 0) +
                    detectedAccounts.filter((a) => a.provider === key).length}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
        <p className="text-ui-sm text-foreground-subtle">{t(provider + "Description")}</p>
        <div className="divide-y divide-border rounded-lg border border-border">
          {snapshot?.accounts
            .filter((a) => a.provider === provider)
            .map((account) => (
              <div
                key={account.id}
                className="space-y-2 px-3 py-3"
                data-testid={`git-account-${account.id}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <KeyRound className="mt-1 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-ui-base font-medium">{account.name}</div>
                    <div className="break-all text-ui-sm text-foreground-subtle">
                      {account.username} · {account.serverUrl}
                    </div>
                    <div className="text-ui-sm text-foreground-subtle">
                      {t(account.auth)}
                      {account.hasToken ? ` · ${t("tokenStored")}` : ""}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("edit") + " " + account.name}
                    disabled={management.pending || Boolean(draft)}
                    onClick={() => start(account)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("delete") + " " + account.name}
                    disabled={management.pending || Boolean(draft)}
                    onClick={() => setDeleteId(account.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                {deleteId === account.id ? (
                  <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                    <span>{t("deleteConfirm")}</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={management.pending}
                      onClick={() =>
                        void management
                          .mutate({
                            type: "delete",
                            expectedRevision: snapshot.revision,
                            id: account.id,
                          })
                          .then((ok) => {
                            if (ok) setDeleteId(null);
                          })
                      }
                    >
                      {t("delete")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={management.pending}
                      onClick={() => setDeleteId(null)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          <GitDetectedAccountList
            accounts={candidates}
            pending={!snapshot || management.pending}
            onImport={(candidateId) => {
              if (snapshot)
                void management.mutate({
                  type: "import",
                  expectedRevision: snapshot.revision,
                  candidateId,
                });
            }}
          />
          {!snapshot?.accounts.some((a) => a.provider === provider) && !candidates.length ? (
            <p
              role={management.detecting ? "status" : undefined}
              className="p-4 text-ui-sm text-foreground-subtle"
            >
              {t(management.detecting ? "detecting" : "empty")}
            </p>
          ) : null}
        </div>
        {draft ? (
          <GitAccountEditor
            draft={draft}
            setDraft={setDraft}
            disabled={management.pending}
            privateKeyPaths={management.detection?.privateKeyPaths ?? []}
            invalid={invalid}
            onSave={() => void save()}
            authorizationReady={Boolean(authorizationRequestId)}
            onAuthorizationReady={(value) => {
              setAuthorizationRequestId(value?.requestId ?? null);
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      username: value?.username ?? (current.id ? current.username : ""),
                    }
                  : current,
              );
            }}
            onCancel={() => {
              setDraft(null);
              setAuthorizationRequestId(null);
              setInvalid(false);
            }}
          />
        ) : null}
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="text-ui-base font-medium">{t("detectedAccounts")}</h3>
        <p className="text-ui-sm text-foreground-subtle">{t("detectionHint")}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={management.detecting}
          onClick={() => void management.detect()}
        >
          {t("detectAccounts")}
        </Button>
        {management.detection ? (
          <>
            <p className="break-all text-ui-sm text-foreground-subtle">
              {management.detection.sshDirectory}
            </p>
            <GitSshKeyList
              paths={management.detection.privateKeyPaths}
              keys={management.detection.sshKeys}
            />
            {management.detection.systemCredentialSources.map((source) => (
              <p
                key={source.source}
                className="text-ui-sm text-foreground-subtle"
                data-testid="git-system-credential-source"
              >
                {t(`source.${source.source}`)} · {t(`sourceStatus.${source.status}`)} ·{" "}
                {source.accountCount}
              </p>
            ))}
            {management.detection.warnings.length ? (
              <p className="text-ui-sm text-warning">{t("detectionPartial")}</p>
            ) : null}
          </>
        ) : null}
      </section>
      {management.detectionError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(management.detectionError)}
        </p>
      ) : null}
      {management.error ? (
        <div role="alert" className="space-y-2 text-ui-sm text-destructive">
          <p>{t(management.error)}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={management.pending}
            onClick={() => void management.reload()}
          >
            {t("reload")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
