import { Emitter } from "@lcode/rpc";
import { randomUUID } from "node:crypto";
import type { ProjectNativeRequest, ProjectNativeResult } from "@lcode/shared";

export interface ProjectNativeBridgeRequest {
  requestId: string;
  originKey: string;
  request: ProjectNativeRequest;
}
export class ProjectNativeBridge {
  private closed = false;
  readonly emitter = new Emitter<ProjectNativeBridgeRequest>();
  private readonly pending = new Map<
    string,
    {
      request: ProjectNativeBridgeRequest;
      resolve(value: ProjectNativeResult): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  call(request: ProjectNativeRequest, originKey: string): Promise<ProjectNativeResult> {
    if (this.closed) return Promise.reject(new Error("Project native connection closed"));
    const envelope = { requestId: randomUUID(), request, originKey };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.respond(envelope.requestId, { error: "Project native Host response timed out" }),
        3_660_000,
      );
      timer.unref?.();
      this.pending.set(envelope.requestId, { request: envelope, resolve, reject, timer });
      this.emitter.fire(envelope);
    });
  }
  subscribe(listener: (request: ProjectNativeBridgeRequest) => void) {
    const subscription = this.emitter.event(listener);
    for (const pending of this.pending.values()) listener(pending.request);
    return subscription;
  }
  respond(requestId: string, result: { value?: ProjectNativeResult; error?: string }): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (result.error) pending.reject(new Error(result.error));
    else pending.resolve(result.value ?? null);
  }
  cancelOwners(owners: Set<string>): void {
    for (const [id, pending] of this.pending)
      if (owners.has(pending.request.request.ownerId))
        this.respond(id, { error: "Project source owner closed" });
  }
  dispose(): void {
    this.closed = true;
    for (const key of this.pending.keys())
      this.respond(key, { error: "Project native connection closed" });
    this.emitter.dispose();
  }
}
