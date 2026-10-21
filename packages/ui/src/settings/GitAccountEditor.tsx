import type { GitAccountInput } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useState } from "react";
import { GitAccountAuthorization } from "./GitAccountAuthorization.js";
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-base";
export function GitAccountEditor({
  draft,
  setDraft,
  disabled,
  privateKeyPaths,
  invalid,
  onSave,
  onCancel,
  onAuthorizationReady,
  authorizationReady,
}: {
  draft: GitAccountInput;
  setDraft: (draft: GitAccountInput) => void;
  disabled: boolean;
  privateKeyPaths: string[];
  invalid: boolean;
  onSave: () => void;
  onCancel: () => void;
  onAuthorizationReady: (value: { requestId: string; username: string } | null) => void;
  authorizationReady: boolean;
}) {
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const { intl } = useLCodeIntl(),
    t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  const field = (
    key: "name" | "serverUrl" | "username" | "privateKeyPath" | "token",
    label: string,
    type = "text",
  ) => (
    <label className="block space-y-2 text-ui-base">
      <span>{t(label)}</span>
      <Input
        aria-label={t(label)}
        type={type}
        autoComplete={type === "password" ? "new-password" : "off"}
        disabled={
          disabled ||
          (authorizationBusy && key === "serverUrl") ||
          (draft.auth === "oauth" && key === "username")
        }
        value={draft[key] ?? ""}
        list={key === "privateKeyPath" ? "git-detected-private-keys" : undefined}
        onChange={(e) => {
          const value = e.target.value;
          let provider = draft.provider;
          if (key === "serverUrl") {
            try {
              const host = new URL(value).hostname;
              if (host === "github.com") provider = "github";
              else if (/gitlab/i.test(host)) provider = "gitlab";
              else if (/gitea|forgejo|codeberg/i.test(host)) provider = "gitea";
            } catch {
              /* 输入草稿尚未形成 URL。 */
            }
          }
          setDraft({ ...draft, [key]: value, provider });
        }}
      />
    </label>
  );
  return (
    <form
      data-testid="git-account-editor"
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h4 className="text-ui-base font-medium">{t(draft.id ? "editAccount" : "addAccount")}</h4>
      {field("name", "accountName")}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-ui-base">
          <span>{t("provider")}</span>
          <select
            aria-label={t("provider")}
            value={draft.provider}
            disabled={disabled || authorizationBusy}
            className={selectClass}
            onChange={(e) =>
              setDraft({ ...draft, provider: e.target.value as GitAccountInput["provider"] })
            }
          >
            {(["github", "gitlab", "gitea", "server"] as const).map((p) => (
              <option key={p} value={p}>
                {t(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-2 text-ui-base">
          <span>{t("authentication")}</span>
          <select
            aria-label={t("authentication")}
            className={selectClass}
            disabled={disabled || authorizationBusy}
            value={draft.auth}
            onChange={(e) => {
              const auth = e.target.value as GitAccountInput["auth"];
              let serverUrl = draft.serverUrl;
              try {
                const url = new URL(serverUrl);
                serverUrl = `${auth === "ssh" ? "ssh" : "https"}://${auth === "ssh" && draft.username ? encodeURIComponent(draft.username) + "@" : ""}${url.host}${url.pathname}`;
              } catch {
                /* 不改写未完成的地址。 */
              }
              setDraft({ ...draft, auth, serverUrl, token: "" });
            }}
          >
            {(["token", "ssh", "system", "oauth"] as const).map((auth) => (
              <option
                key={auth}
                value={auth}
                disabled={auth === "oauth" && draft.provider === "server"}
              >
                {t(auth)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {field("serverUrl", "serverUrl")}
      {field("username", "username")}
      {draft.auth === "oauth" ? (
        <GitAccountAuthorization
          draft={draft}
          disabled={disabled}
          onBusy={setAuthorizationBusy}
          onReady={onAuthorizationReady}
        />
      ) : null}
      {draft.auth === "token" ? (
        <>
          {field("token", "token", "password")}
          <p className="text-ui-sm text-foreground-subtle">
            {t(draft.id ? "keepToken" : "tokenHint")}
          </p>
        </>
      ) : null}
      {draft.auth === "ssh" ? (
        <>
          {field("privateKeyPath", "privateKeyPath")}
          <datalist id="git-detected-private-keys">
            {privateKeyPaths.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <p className="text-ui-sm text-foreground-subtle">{t("sshHint")}</p>
        </>
      ) : null}
      {invalid ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t("invalid")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            disabled ||
            (draft.auth === "oauth" && !authorizationReady && (!draft.id || authorizationBusy))
          }
        >
          {t("saveAccount")}
        </Button>
      </div>
    </form>
  );
}
