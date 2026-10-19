import type {
  MessageId,
  MessageInfo,
  MessagePart,
  SessionId,
  SessionInputDelivery,
  SessionInputStatus,
  SessionInputRecord,
  SessionStorePort,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";

// Admission 的持久事实仍写入同一连接；这里只拆分方法，不复制状态或队列。
export const sessionInputMethods = {
  async saveSessionInput(
    this: SqliteStoreAccess,
    input: {
      id: string;
      sessionID: SessionId;
      kind: string;
      delivery: SessionInputDelivery;
      payload: { text: string; [key: string]: unknown };
    },
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  },

  async commitPermissionFullAccess(
    this: SqliteStoreAccess,
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  },

  async updateSessionInputs(
    this: SqliteStoreAccess,
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  },

  async promoteSessionInput(
    this: SqliteStoreAccess,
    input: {
      id: string;
      sessionID: SessionId;
      message: MessageInfo;
      parts: MessagePart[];
    },
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  },

  async markSessionInputPromoted(
    this: SqliteStoreAccess,
    input: {
      id: string;
      sessionID: SessionId;
      promotedMessageID: MessageId;
    },
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  },

  async settleSessionInput(
    this: SqliteStoreAccess,
    input: {
      id: string;
      sessionID: SessionId;
      status: "cancelled" | "discarded" | "failed";
      reason?: string;
    },
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  },

  async listSessionInputs(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      status?: SessionInputStatus;
    },
  ): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  },

  async getSessionInputById(
    this: SqliteStoreAccess,
    id: string,
  ): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  },
};
