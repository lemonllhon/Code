import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { IServiceAccessor } from "@lcode/services";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { useCommitReviewNavigationStore } from "@/store/commitReviewNavigationStore.js";

type Entry = {
  token: string;
  source: HTMLElement | null;
  content: ReactNode;
  services: IServiceAccessor;
};
type Registry = {
  attach(scope: string, entry: Entry): void;
  update(scope: string, token: string, content: ReactNode, services: IServiceAccessor): void;
  detach(scope: string, token: string): void;
};
const Context = createContext<Registry | null>(null);

function ControllerSurface({ entry }: { entry: Entry }) {
  const parking = useRef<HTMLDivElement>(null);
  const [container] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    const target = entry.source ?? parking.current;
    if (target && container.parentNode !== target) target.append(container);
  });
  return (
    <div ref={parking} hidden>
      {createPortal(
        <ServiceProvider services={entry.services}>{entry.content}</ServiceProvider>,
        container,
      )}
    </div>
  );
}

/** 只保留原控制器的呈现树；审核事实仍归 Host，切会话不能复制或卸载独立窗口的控制器。 */
export function RetainedGitActionMenuProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const [, invalidate] = useReducer((value: number) => value + 1, 0);
  const registry = useMemo<Registry>(() => {
    const retained = (scope: string) => {
      const element = useCommitReviewNavigationStore.getState().paneHosts[scope]?.element;
      return element && element.ownerDocument !== document;
    };
    return {
      attach(scope, entry) {
        entries.current.set(scope, entry);
        invalidate();
      },
      update(scope, token, content, services) {
        const entry = entries.current.get(scope);
        if (
          !entry ||
          entry.token !== token ||
          (entry.content === content && entry.services === services)
        )
          return;
        entries.current.set(scope, { ...entry, content, services });
        invalidate();
      },
      detach(scope, token) {
        const entry = entries.current.get(scope);
        if (!entry || entry.token !== token) return;
        if (retained(scope)) entries.current.set(scope, { ...entry, source: null });
        else entries.current.delete(scope);
        invalidate();
      },
    };
  }, []);
  useLayoutEffect(
    () =>
      useCommitReviewNavigationStore.subscribe((state) => {
        let changed = false;
        for (const [scope, entry] of entries.current) {
          if (
            !entry.source &&
            state.paneHosts[scope]?.element.ownerDocument !== document &&
            state.paneHosts[scope]
          )
            continue;
          if (!entry.source) {
            entries.current.delete(scope);
            changed = true;
          }
        }
        if (changed) invalidate();
      }),
    [],
  );
  return (
    <Context.Provider value={registry}>
      {children}
      {[...entries.current].map(([scope, entry]) => (
        <ControllerSurface key={scope} entry={entry} />
      ))}
    </Context.Provider>
  );
}

export function RetainedGitActionMenu({ scope, children }: { scope: string; children: ReactNode }) {
  const registry = useContext(Context);
  const services = useServices();
  const source = useRef<HTMLDivElement>(null);
  const token = useMemo(() => crypto.randomUUID(), [scope]);
  const latest = useRef({ children, services });
  latest.current = { children, services };
  useLayoutEffect(() => {
    if (!registry || !source.current) return;
    registry.attach(scope, {
      token,
      source: source.current,
      content: latest.current.children,
      services: latest.current.services,
    });
    return () => registry.detach(scope, token);
  }, [registry, scope, token]);
  useLayoutEffect(
    () => registry?.update(scope, token, children, services),
    [children, registry, scope, services, token],
  );
  return registry ? <div ref={source} className="contents" /> : children;
}
