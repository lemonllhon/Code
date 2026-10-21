import { AsyncLocalStorage } from "node:async_hooks";
import type { GitRepositoryAuthenticationRequest } from "@lcode/shared";

const scope = new AsyncLocalStorage<GitRepositoryAuthenticationRequest>();
export const currentGitAuthenticationScope = () => scope.getStore();
/** 仅传递原调用的 Host/identity，不增加队列、writer 或重试。 */
export function withGitAuthenticationScope<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const request = args[0] as GitRepositoryAuthenticationRequest | undefined;
        return request && typeof request.workspacePath === "string"
          ? scope.run(request, () => Reflect.apply(value, target, args))
          : Reflect.apply(value, target, args);
      };
    },
  });
}
