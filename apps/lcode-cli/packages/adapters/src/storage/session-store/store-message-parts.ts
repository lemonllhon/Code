import type { MessagePart, SessionStorePort } from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as parts from "./repositories/message-parts.js";

// 与其它 store 方法模块相同，只借用唯一连接与写守卫，不持有独立缓存或事务队列。
export const messagePartMethods = {
  async savePart(
    this: SqliteStoreAccess,
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return parts.savePart(this.db, input, copyFrom);
  },
  async saveParts(
    this: SqliteStoreAccess,
    input: Parameters<SessionStorePort["saveParts"]>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    parts.saveParts(this.db, input);
  },
};
