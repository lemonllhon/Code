import { useId, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import type { GitDetectedSshKey } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

function SshKeyItem({ item }: { item: GitDetectedSshKey }) {
  const { intl } = useLCodeIntl(),
    id = useId();
  const [expanded, setExpanded] = useState(false);
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  const name = item.privateKeyPath.split(/[\\/]/).at(-1) || item.privateKeyPath;
  const label = intl.formatMessage(
    { id: `settings.gitManagement.${expanded ? "hideSshKey" : "viewSshKey"}` },
    { name },
  );
  return (
    <li className="min-w-0 px-3 py-3" data-testid="git-ssh-key">
      <div className="flex min-w-0 items-center gap-3">
        <KeyRound className="size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-ui-base font-medium">
            <span className="break-all">{name}</span>
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {item.keyType ?? t("keyTypeUnavailable")}
            </span>
          </div>
          <p className="break-all text-ui-sm text-foreground-subtle">{item.privateKeyPath}</p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          title={label}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
      {expanded ? (
        <div
          id={id}
          className="mt-3 min-w-0 space-y-3 border-t border-border pt-3"
          data-testid="git-ssh-key-details"
        >
          <dl className="grid min-w-0 gap-2 text-ui-sm">
            {[
              [t("keyType"), item.keyType ?? t("notFound")],
              [t("privateKeyPath"), item.privateKeyPath],
              [t("publicKeyPath"), item.publicKeyPath],
              [t("fingerprint"), item.fingerprint ?? t("notFound")],
            ].map(([title, value]) => (
              <div key={title} className="min-w-0">
                <dt className="text-foreground-subtle">{title}</dt>
                <dd className="break-all select-text">{value}</dd>
              </div>
            ))}
          </dl>
          {item.publicKey ? (
            <label className="flex min-w-0 flex-col gap-2 text-ui-sm">
              <span>{t("publicKey")}</span>
              <textarea
                readOnly
                value={item.publicKey}
                rows={3}
                className="w-full min-w-0 resize-y rounded-md border border-input-border bg-input px-2 py-1 font-mono text-ui-base text-foreground outline-none focus-visible:border-input-border-focused"
              />
            </label>
          ) : (
            <p className="text-ui-sm text-foreground-subtle">{t("publicKeyUnavailable")}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function GitSshKeyList({ paths, keys }: { paths: string[]; keys: GitDetectedSshKey[] }) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  return (
    <div className="min-w-0 space-y-2" data-testid="git-ssh-key-list">
      <h4 className="text-ui-base font-medium">{t("sshKeys")}</h4>
      <p className="text-ui-sm text-foreground-subtle">{t("sshKeyExplanation")}</p>
      {paths.length ? (
        <ul className="min-w-0 divide-y divide-border rounded-lg border border-border">
          {paths.map((path) => (
            <SshKeyItem
              key={path}
              item={
                keys.find((key) => key.privateKeyPath === path) ?? {
                  privateKeyPath: path,
                  publicKeyPath: path + ".pub",
                  keyType: null,
                  fingerprint: null,
                  publicKey: null,
                }
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">{t("notFound")}</p>
      )}
    </div>
  );
}
