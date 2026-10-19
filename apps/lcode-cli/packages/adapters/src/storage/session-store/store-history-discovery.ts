import type {
  DiscoverSessionHistoryInput,
  ReadSessionTranscriptWindowInput,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import { discoverSessionHistory } from "./repositories/history-discovery.js";
import { readTranscriptWindow } from "./repositories/transcript-window.js";

export const historyDiscoveryMethods = {
  async readTranscriptWindow(this: SqliteStoreAccess, input: ReadSessionTranscriptWindowInput) {
    return readTranscriptWindow(this.db, input);
  },
  discoverSessionHistory(this: SqliteStoreAccess, input: DiscoverSessionHistoryInput) {
    return discoverSessionHistory(this.db, input);
  },
};
