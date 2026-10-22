import type { ServiceCollection } from "./collection.js";

const borrowedResources = new WeakMap<ServiceCollection, Set<object>>();
const localDisposers = new WeakMap<ServiceCollection, Array<() => unknown>>();

/** 登记不属于 RPC 接口的本地订阅；Host 关闭时在断开 transport 前释放。 */
export function registerServiceResourceDisposer(
  services: ServiceCollection,
  disposer: () => unknown,
): void {
  const disposers = localDisposers.get(services) ?? [];
  disposers.push(disposer);
  localDisposers.set(services, disposers);
}

export function takeServiceResourceDisposers(services: ServiceCollection): Array<() => unknown> {
  const disposers = localDisposers.get(services) ?? [];
  localDisposers.delete(services);
  return disposers;
}

/** 远端代理只借用调用权；释放权始终属于创建资源的 Host。 */
export function registerBorrowedServiceResources(
  services: ServiceCollection,
  resources: object[],
): void {
  const borrowed = borrowedResources.get(services) ?? new Set<object>();
  for (const resource of resources) borrowed.add(resource);
  borrowedResources.set(services, borrowed);
}

export function ownsServiceResource(services: ServiceCollection, resource: object): boolean {
  return !borrowedResources.get(services)?.has(resource);
}

/** 保留有序释放，但任何一次失败都不能跳过后面的资源。 */
export async function disposeResourceSteps(
  steps: Array<{ name: string; run: () => unknown }>,
): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      failures.push(new Error(`Resource cleanup failed: ${step.name}`, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Resource cleanup failed");
}
