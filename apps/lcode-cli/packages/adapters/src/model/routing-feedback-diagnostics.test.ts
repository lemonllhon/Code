import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "@lcode/contracts";
import { createRoutingFeedback } from "./routing-feedback.js";

for (const mode of ["success", "400", "503", "network", "timeout"] as const) {
  test(`routing feedback ${mode} has bounded immutable retries and safe diagnostics`, async () => {
    const bodies: string[] = [];
    let warning: Record<string, unknown> | undefined;
    const fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      if (mode === "network") throw new Error("private-fixture-url-and-credential");
      if (mode === "timeout")
        throw new DOMException("private-fixture-url-and-credential", "TimeoutError");
      return new Response(null, { status: mode === "success" ? 204 : Number(mode) });
    }) as typeof globalThis.fetch;
    const send = createRoutingFeedback(
      fetch,
      "https://fixture.invalid",
      "private-fixture-credential",
      {
        warn(_message: string, context: Record<string, unknown>) {
          warning = context;
        },
      } as Logger,
    );
    await send({ outcome: "failed", replaySafeFailure: false });
    assert.equal(bodies.length, ["success", "400"].includes(mode) ? 1 : 3);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(send.diagnostics().delivered, mode === "success");
    if (mode === "success") assert.equal(warning, undefined);
    else {
      assert.equal(warning?.failureKind, mode === "network" || mode === "timeout" ? mode : "http");
      assert.equal(JSON.stringify(warning).includes("private-fixture"), false);
      assert.equal(
        warning?.statusCode,
        mode === "400" || mode === "503" ? Number(mode) : undefined,
      );
    }
  });
}
