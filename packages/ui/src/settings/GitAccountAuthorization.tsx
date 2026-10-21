import { useEffect, useRef, useState } from "react";
import { CircleHelp, ExternalLink } from "lucide-react";
import type { GitAccountInput } from "@lcode/shared";
import { useGitAccountAuthorization } from "@/hooks/useGitAccountAuthorization.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

export function GitAccountAuthorization({
  draft,
  disabled,
  onReady,
  onBusy,
}: {
  draft: GitAccountInput;
  disabled: boolean;
  onReady: (value: { requestId: string; username: string } | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const authorization = useGitAccountAuthorization(),
    platform = usePlatform(),
    { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  const [clientId, setClientId] = useState(""),
    [redirectUri, setRedirectUri] = useState("http://127.0.0.1:17654/git-auth/callback"),
    [callbackUrl, setCallbackUrl] = useState(""),
    [help, setHelp] = useState(false),
    [browserError, setBrowserError] = useState(false);
  const reported = useRef<string | null>(null),
    status = authorization.status;
  const helpClosing = useRef(false);
  const fixed = Boolean(status && ["pending", "ready", "saving"].includes(status.status));
  useEffect(() => {
    onBusy(fixed);
    return () => onBusy(false);
  }, [fixed, onBusy]);
  useEffect(() => {
    if (status?.status === "ready" && status.username && reported.current !== status.requestId) {
      reported.current = status.requestId;
      onReady({ requestId: status.requestId, username: status.username });
    }
  }, [status, onReady]);
  const open = async (url: string) => {
    try {
      await platform.openExternal(url);
      setBrowserError(false);
    } catch {
      setBrowserError(true);
    }
  };
  let applicationUrl = "";
  try {
    const url = new URL(draft.serverUrl);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      applicationUrl =
        url.origin +
        url.pathname.replace(/\/$/, "") +
        (draft.provider === "github"
          ? "/settings/developers"
          : draft.provider === "gitlab"
            ? "/-/user_settings/applications"
            : "/user/settings/applications");
  } catch {
    /* 地址草稿尚未完成。 */
  }
  return (
    <div
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="git-account-authorization"
    >
      <div className="flex items-center gap-2">
        <span className="text-ui-base font-medium">{t("oauth")}</span>
        <Popover open={help} onOpenChange={setHelp}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("oauthHelp")}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setHelp(true);
              }}
              onFocus={() => {
                if (!helpClosing.current) setHelp(true);
                helpClosing.current = false;
              }}
              onClick={(event) => {
                event.preventDefault();
                setHelp(true);
              }}
            >
              <CircleHelp className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-ui-sm"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={() => {
              helpClosing.current = true;
            }}
            data-testid="git-oauth-help"
          >
            <p className="font-medium">{t("oauthHelp")}</p>
            <ol className="list-decimal space-y-2 pl-4">
              <li>{t("oauthHelpClient")}</li>
              <li>
                {t(
                  draft.provider === "github"
                    ? "oauthHelpGithub"
                    : draft.provider === "gitlab"
                      ? "oauthHelpGitlab"
                      : "oauthHelpGitea",
                )}
              </li>
              <li className="break-all">
                {t("oauthHelpCallback")} {redirectUri}
              </li>
              <li>{t("oauthHelpSave")}</li>
            </ol>
            {applicationUrl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void open(applicationUrl)}
              >
                {t("oauthCreateApp")}
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      <label className="flex flex-col gap-2 text-ui-base">
        <span>Client ID</span>
        <Input
          aria-label="OAuth Client ID"
          autoComplete="off"
          value={clientId}
          disabled={disabled || fixed}
          onChange={(event) => setClientId(event.target.value)}
        />
      </label>
      {draft.provider !== "github" ? (
        <label className="flex flex-col gap-2 text-ui-base">
          <span>{t("oauthRedirect")}</span>
          <Input
            aria-label={t("oauthRedirect")}
            value={redirectUri}
            disabled={disabled || fixed}
            onChange={(event) => setRedirectUri(event.target.value)}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            disabled ||
            authorization.pending ||
            fixed ||
            !clientId.trim() ||
            draft.provider === "server"
          }
          onClick={() => {
            reported.current = null;
            onReady(null);
            void authorization
              .start({
                provider: draft.provider as "github" | "gitlab" | "gitea",
                serverUrl: draft.serverUrl,
                clientId: clientId.trim(),
                redirectUri,
              })
              .then((next) => {
                if (next?.authorizeUrl) void open(next.authorizeUrl);
              });
          }}
        >
          {t("oauthStart")}
        </Button>
        {status?.authorizeUrl ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void open(status.authorizeUrl!)}
          >
            {t("oauthOpenBrowser")}
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
        {status ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              reported.current = null;
              onReady(null);
              void authorization.cancel();
            }}
          >
            {t("oauthCancel")}
          </Button>
        ) : null}
      </div>
      {status?.userCode ? (
        <p className="text-ui-base select-text">
          {t("oauthUserCode")} <strong>{status.userCode}</strong>
        </p>
      ) : null}
      {status ? (
        <p role="status" className="break-words text-ui-sm text-foreground-subtle">
          {t(`oauthStatus.${status.status}`)} {status.username}
        </p>
      ) : null}
      {status?.status === "pending" && draft.provider !== "github" ? (
        <div className="space-y-2">
          <p className="text-ui-sm text-foreground-subtle">{t("oauthCallbackHint")}</p>
          <Input
            aria-label={t("oauthCallbackUrl")}
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={authorization.pending || !callbackUrl}
            onClick={() => void authorization.callback(callbackUrl)}
          >
            {t("oauthSubmitCallback")}
          </Button>
        </div>
      ) : null}
      {status?.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(status.error)}
        </p>
      ) : null}
      {authorization.error || browserError ? (
        <div role="alert" className="space-y-2 text-ui-sm text-destructive">
          <p>{t(browserError ? "oauthBrowserFailed" : (authorization.error ?? "oauth-failed"))}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void authorization.retry()}
          >
            {t("reload")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
