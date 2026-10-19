import type { MessageId, SessionId } from "../shared.js";
import type { SessionInfo } from "./session-records.js";

export const HISTORY_DISCOVERY_SESSION_LIMIT = 256;
export const HISTORY_DISCOVERY_PART_LIMIT = 16;
export const HISTORY_DISCOVERY_PART_BYTES = 16 * 1024;
export const HISTORY_DISCOVERY_TOTAL_BYTES = 2 * 1024 * 1024;
export const HISTORY_DISCOVERY_TERM_LIMIT = 12;
export const HISTORY_DISCOVERY_TERM_CHARACTERS = 64;
export interface DiscoverSessionHistoryInput {
  workspaceRoot: string;
  workspaceIdentity?: string;
  excludeSessionID: SessionId;
  queryTerms: string[];
  limit: number;
  signal?: AbortSignal;
}
export interface DiscoveredSessionHistory {
  candidates: Array<{ session: SessionInfo; throughMessageID?: MessageId }>;
  partial: boolean;
}
