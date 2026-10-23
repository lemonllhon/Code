import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler } from "../src/routing/scheduler.js";
import type { RoutingCandidate } from "@lcode/shared/provider-routing";

for (const indexed of [false, true])
  test(`hard quota rejection takes priority over capacity wait (indexed=${indexed})`, () => {
    const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
    const candidate: RoutingCandidate = {
      id: "fixture",
      generation: "1",
      maxInFlight: 1,
      portability: "portable",
      windows: [
        {
          resourceId: "tokens",
          instanceId: "one",
          revision: 1,
          kind: "budget",
          quality: "fresh",
          unit: "tokens",
          remaining: 100,
          limit: 100,
        },
      ],
    };
    const request = (attemptId: string) => ({
      scopeKey: "fixture",
      attemptId,
      tokens: { total: 60, quality: "bound" as const },
    });
    if (indexed) owner.setDirectory([candidate.id], () => candidate);
    const reserve = (id: string) => {
      if (!indexed) return owner.reserve([candidate], request(id));
      for (const _ of owner.prepareIndexed(request(id))) {
        /* prepare the same owner */
      }
      return owner.reserveIndexed(request(id));
    };
    try {
      const lease = reserve("first");
      lease.dispatch();
      assert.throws(
        () => reserve("blocked"),
        (error: unknown) => (error as { code?: string }).code === "quota-exhausted",
      );
      lease.finish({ actualDemands: { tokens: 10 }, tokens: { total: 10 }, outcome: "success" });
      reserve("after").cancel();
    } finally {
      owner.dispose();
    }
  });
