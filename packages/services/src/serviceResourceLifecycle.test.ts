import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection } from "./collection.js";
import {
  disposeResourceSteps,
  ownsServiceResource,
  registerBorrowedServiceResources,
} from "./serviceResourceLifecycle.js";

test("resource ownership does not inspect or dispose borrowed RPC proxies", () => {
  const collection = new ServiceCollection();
  const proxy = new Proxy(
    {},
    {
      has() {
        assert.fail("must not inspect remote disposal hooks");
      },
      get() {
        assert.fail("must not invoke remote disposal hooks");
      },
    },
  );
  registerBorrowedServiceResources(collection, [proxy]);
  assert.equal(ownsServiceResource(collection, proxy), false);
  assert.equal(ownsServiceResource(collection, {}), true);
  assert.equal(ownsServiceResource(new ServiceCollection(), proxy), true);
});

test("ordered cleanup attempts and settles every owner and preserves each failure", async () => {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const errors = [new Error("sync"), new Error("async")];
  let settled = false;
  const operation = disposeResourceSteps([
    {
      name: "local",
      run: () => {
        calls.push("local");
        throw errors[0];
      },
    },
    {
      name: "transport",
      run: async () => {
        calls.push("transport");
        await gate.promise;
        throw errors[1];
      },
    },
    {
      name: "last",
      run: () => {
        calls.push("last");
      },
    },
  ]);
  const checked = assert
    .rejects(operation, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((item: Error) => item.cause),
        errors,
      );
      return true;
    })
    .then(() => {
      settled = true;
    });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls, ["local", "transport"]);
  gate.resolve();
  await checked;
  assert.deepEqual(calls, ["local", "transport", "last"]);
});
