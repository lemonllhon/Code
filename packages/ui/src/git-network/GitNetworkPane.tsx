import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowDownUp,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useGitNetwork } from "@/hooks/useGitNetwork.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitRemoteEditor } from "./GitRemoteEditor.js";
import { GitRepositoryImportForm } from "@/git-workspace/GitRepositoryImportForm.js";
import { GitPublicationHost } from "@/git-action-menu/GitPublicationPortal.js";

export function GitNetworkPane(props: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onRefresh?: () => void;
  publicationScope?: string;
  visible?: boolean;
}) {
  const network = useGitNetwork(props);
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.network.${key}` });
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [upstream, setUpstream] = useState("");
  const { snapshot, confirmation, receipt } = network;
  const remotes = snapshot?.remotes ?? [];
  const targets = selected.filter((name) => remotes.some((remote) => remote.name === name));
  const canConfirm =
    network.ready &&
    (confirmation?.kind !== "fast-forward" || confirmation.preview.reason === "ready");
  const control = "h-7 rounded border border-border bg-input px-1 text-ui-sm disabled:opacity-50";
  const receiptUnknown = receipt?.status === "unknown" || receipt?.status === "running";
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-ui-sm"
      data-testid="git-network-pane"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <GitBranch className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate" title={snapshot?.branch ?? undefined}>
          {snapshot?.branch ?? t("detached")}
        </span>
        <span className="shrink-0 text-ui-xs text-foreground-subtle" title={t("counts")}>
          ↑{snapshot?.ahead ?? 0} ↓{snapshot?.behind ?? 0}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("refresh")}
          aria-label={t("refresh")}
          disabled={network.pending}
          onClick={network.refresh}
        >
          <RefreshCw className={network.pending ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {network.error ? (
          <p
            role="alert"
            className="break-words px-3 py-2 text-ui-sm text-destructive"
            data-testid="git-network-error"
          >
            {t(network.error)}
          </p>
        ) : null}
        {network.error && !snapshot ? (
          <div className="border-b border-border px-3 py-2">
            <GitRepositoryImportForm
              initialDirectory={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              workspaceRemoteSessionId={props.workspaceRemoteSessionId}
              onImported={() => {
                network.refresh();
                props.onRefresh?.();
              }}
            />
          </div>
        ) : null}
        <div className="space-y-2 border-b border-border px-3 py-2">
          <p
            className="truncate text-ui-xs text-foreground-subtle"
            title={snapshot?.upstream ?? undefined}
          >
            {t("upstream")}: {snapshot?.upstream ?? "—"}
          </p>
          <div className="flex min-w-0 gap-1">
            <select
              aria-label={t("upstream")}
              className={`${control} min-w-0 flex-1`}
              value={upstream}
              disabled={!network.ready || !snapshot?.branch}
              onChange={(event) => setUpstream(event.target.value)}
            >
              <option value="">{t("selectUpstream")}</option>
              <option value="none">{t("unsetTracking")}</option>
              {snapshot?.remoteBranches.map((item) => (
                <option
                  key={`${item.remote}/${item.branch}`}
                  value={`${item.remote}/${item.branch}`}
                >
                  {item.remote}/{item.branch}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!network.ready || !upstream}
              onClick={() => {
                const target = snapshot?.remoteBranches.find(
                  (item) => `${item.remote}/${item.branch}` === upstream,
                );
                if (upstream === "none" || target)
                  network.prepareTracking(
                    target ? { remote: target.remote, branch: target.branch } : null,
                  );
              }}
            >
              {t("setTracking")}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <span className="flex-1 font-medium">{t("title")}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("add")}
            title={t("add")}
            disabled={!network.ready}
            onClick={() => {
              setEditing("");
              setRenaming(null);
            }}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        {remotes.length === 0 && snapshot ? (
          <p className="px-3 py-4 text-ui-sm text-foreground-subtle">{t("empty")}</p>
        ) : null}
        {remotes.map((remote) => (
          <div key={remote.name} className="border-b border-border">
            <div className="group flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover">
              <input
                type="checkbox"
                aria-label={`${t("selectRemote")} ${remote.name}`}
                checked={targets.includes(remote.name)}
                disabled={!network.ready}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, remote.name]
                      : current.filter((name) => name !== remote.name),
                  )
                }
                className="size-3.5 shrink-0 accent-brand"
              />
              <span className="min-w-0 flex-1 truncate font-medium">{remote.name}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("edit")} ${remote.name}`}
                title={t("edit")}
                disabled={!network.ready}
                onClick={() => {
                  setEditing(remote.name);
                  setRenaming(null);
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("rename")} ${remote.name}`}
                title={t("rename")}
                disabled={!network.ready}
                onClick={() => {
                  setRenaming(remote.name);
                  setNewName(remote.name);
                  setEditing(null);
                }}
              >
                <ArrowDownUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("remove")} ${remote.name}`}
                title={t("remove")}
                disabled={!network.ready}
                onClick={() => network.prepareRemote({ action: "remove", name: remote.name })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-0.5 px-8 pb-2 text-ui-xs text-foreground-subtle">
              {remote.fetchUrls.map((url, index) => (
                <p key={`fetch-${index}`} className="break-all">
                  <span className="mr-2">Fetch</span>
                  {url}
                </p>
              ))}
              {remote.pushUrls.length ? (
                remote.pushUrls.map((url, index) => (
                  <p key={`push-${index}`} className="break-all">
                    <span className="mr-2">Push</span>
                    {url}
                  </p>
                ))
              ) : (
                <p>Push · {t("inheritFetch")}</p>
              )}
            </div>
          </div>
        ))}
        {editing !== null ? (
          <GitRemoteEditor
            key={editing}
            remote={remotes.find((remote) => remote.name === editing) ?? null}
            pending={!network.ready}
            onCancel={() => setEditing(null)}
            onSave={(params) => {
              network.prepareRemote(params);
              setEditing(null);
            }}
          />
        ) : null}
        {renaming !== null ? (
          <form
            className="flex gap-1 border-b border-border px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              network.prepareRemote({ action: "rename", name: renaming, newName: newName.trim() });
              setRenaming(null);
            }}
          >
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              aria-label={t("newName")}
              autoFocus
            />
            <Button size="sm" type="submit" disabled={!network.ready || !newName.trim()}>
              {t("reviewChanges")}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </form>
        ) : null}
        {props.publicationScope ? (
          <GitPublicationHost scope={props.publicationScope} visible={props.visible !== false} />
        ) : null}
        {confirmation ? (
          <section
            className="space-y-2 border-b border-border bg-surface px-3 py-3"
            data-testid="git-network-confirmation"
          >
            <p className="font-medium">
              {t(confirmation.kind === "fast-forward" ? "update" : "confirmConfig")}
            </p>
            {confirmation.kind === "fast-forward" ? (
              <>
                <p className="break-all font-mono text-ui-xs">
                  {confirmation.preview.branch} ← {confirmation.preview.upstream}
                </p>
                <p className="break-all font-mono text-ui-xs">
                  {confirmation.preview.head?.slice(0, 12) ?? "—"} →{" "}
                  {confirmation.preview.target?.slice(0, 12) ?? "—"}
                </p>
                <p role="status" className="text-ui-sm text-foreground-subtle">
                  {t(`reason.${confirmation.preview.reason}`)}
                </p>
              </>
            ) : confirmation.kind === "tracking" ? (
              <p className="break-all">
                {confirmation.params.branch} →{" "}
                {confirmation.params.upstream
                  ? `${confirmation.params.upstream.remote}/${confirmation.params.upstream.branch}`
                  : t("unsetTracking")}
              </p>
            ) : (
              <>
                <p className="break-all">
                  {t(confirmation.params.action)} · {confirmation.params.name}
                  {confirmation.params.newName ? ` → ${confirmation.params.newName}` : ""}
                </p>
                {confirmation.params.fetchUrls?.map((url, index) => (
                  <p className="break-all text-ui-xs" key={`f${index}`}>
                    Fetch · {url}
                  </p>
                ))}
                {confirmation.params.pushUrls?.map((url, index) => (
                  <p className="break-all text-ui-xs" key={`p${index}`}>
                    Push · {url}
                  </p>
                ))}
                <p className="text-ui-xs text-foreground-subtle">
                  {t(confirmation.params.action === "remove" ? "removeHint" : "configHint")}
                </p>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={network.pending} onClick={network.cancel}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                size="sm"
                data-testid="git-network-confirm"
                disabled={!canConfirm}
                onClick={network.confirm}
              >
                {t("confirm")}
              </Button>
            </div>
          </section>
        ) : null}
        {receipt ? (
          <section
            className="space-y-1 border-b border-border px-3 py-2 text-ui-xs"
            role="status"
            data-testid="git-network-receipt"
          >
            <p>
              {t(`kind.${receipt.kind}`)} · {t(`status.${receipt.status}`)}
            </p>
            <p className="text-foreground-subtle">{receipt.finishedAt ?? receipt.startedAt}</p>
            {receipt.results?.map((result) => (
              <p key={result.remote}>
                {result.remote} · {t(`status.${result.status}`)}
              </p>
            ))}
            {receipt.code ? (
              <p className="break-words text-destructive">{t(`error.${receipt.code}`)}</p>
            ) : null}
            {receiptUnknown ? <p className="text-foreground-subtle">{t("unknownHint")}</p> : null}
          </section>
        ) : null}
        {snapshot?.branches.length ? (
          <details className="px-3 py-2">
            <summary className="cursor-pointer text-ui-xs text-foreground-subtle">
              {t("localBranches")} · {snapshot.branches.length}
            </summary>
            {snapshot.branches.map((branch) => (
              <p
                key={branch.name}
                className="truncate py-1 text-ui-xs"
                title={`${branch.name} → ${branch.upstream ?? "—"}`}
              >
                {branch.name} → {branch.upstream ?? "—"}
              </p>
            ))}
          </details>
        ) : null}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!network.ready || !targets.length}
          onClick={() => network.fetch(targets)}
          data-testid="git-network-fetch"
        >
          <ArrowDownToLine className="mr-1 size-3.5" />
          Fetch{targets.length ? ` (${targets.length})` : ""}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!network.ready}
          onClick={network.preview}
          data-testid="git-network-update"
        >
          {t("update")}
        </Button>
        <span className="text-ui-xs text-foreground-subtle">{t("localRefreshHint")}</span>
      </footer>
    </section>
  );
}
