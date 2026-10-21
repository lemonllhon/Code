import { useState } from "react";
import type { GitNetworkSnapshot, GitRemoteMutationRequest } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

type Remote = GitNetworkSnapshot["remotes"][number];
type Mutation = Omit<
  GitRemoteMutationRequest,
  "workspacePath" | "workspaceIdentity" | "requestId" | "expectedRevision"
>;
export function GitRemoteEditor({
  remote,
  pending,
  onSave,
  onCancel,
}: {
  remote: Remote | null;
  pending: boolean;
  onSave: (params: Mutation) => void;
  onCancel: () => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.network.${key}` });
  const [name, setName] = useState(remote?.name ?? "");
  const [fetchUrls, setFetchUrls] = useState(remote?.fetchUrls.join("\n") ?? "");
  const [pushUrls, setPushUrls] = useState(remote?.pushUrls.join("\n") ?? "");
  const values = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  return (
    <form
      className="space-y-2 border-b border-border bg-surface px-3 py-2"
      data-testid="git-remote-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          action: remote ? "edit" : "add",
          name: remote?.name ?? name.trim(),
          fetchUrls: values(fetchUrls),
          pushUrls: values(pushUrls),
        });
      }}
    >
      <label className="block text-ui-sm">
        {t("name")}
        <Input
          aria-label={t("name")}
          value={name}
          disabled={pending || Boolean(remote)}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </label>
      <label className="block text-ui-sm">
        {t("fetchUrls")}
        <Textarea
          aria-label={t("fetchUrls")}
          value={fetchUrls}
          onChange={(event) => setFetchUrls(event.target.value)}
          disabled={pending}
          rows={2}
          className="min-h-14 break-all"
        />
      </label>
      <label className="block text-ui-sm">
        {t("pushUrls")}
        <Textarea
          aria-label={t("pushUrls")}
          value={pushUrls}
          onChange={(event) => setPushUrls(event.target.value)}
          disabled={pending}
          rows={2}
          className="min-h-14 break-all"
        />
      </label>
      <p className="text-ui-xs text-foreground-subtle">{t("urlHint")}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          size="sm"
          type="submit"
          disabled={pending || !name.trim() || !values(fetchUrls).length}
        >
          {t("reviewChanges")}
        </Button>
      </div>
    </form>
  );
}
