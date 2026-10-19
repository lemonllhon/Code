import type {
  DiscoverSessionHistoryInput,
  ReadSessionTranscriptWindowInput,
  ReadMemoryReviewEvidenceInput,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import { discoverSessionHistory } from "./repositories/history-discovery.js";
import { readTranscriptWindow } from "./repositories/transcript-window.js";
import { readMemoryReviewEvidence } from "./repositories/memory-evidence.js";

export const historyDiscoveryMethods = {
  async readMemoryReviewEvidence(this: SqliteStoreAccess, input: ReadMemoryReviewEvidenceInput) {
    return readMemoryReviewEvidence(this.db, input);
  },
  async readTranscriptWindow(this: SqliteStoreAccess, input: ReadSessionTranscriptWindowInput) {
    return readTranscriptWindow(this.db, input);
  },
  discoverSessionHistory(this: SqliteStoreAccess, input: DiscoverSessionHistoryInput) {
    return discoverSessionHistory(this.db, input);
  },
};
