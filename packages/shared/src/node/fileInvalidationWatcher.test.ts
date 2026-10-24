import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { watchFileInvalidation } from "./fileInvalidationWatcher.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
function fixture() {
  const directory = join(tmpdir(), `watch-unit-${randomUUID()}`);
  const handles: {
    change: (name: string | null) => void;
    error: (error: unknown) => void;
    closes: number;
  }[] = [];
  const errors: string[] = [];
  const dependencies = {
    createDirectory: async (_directory: string) => {},
    watchDirectory: (
      _directory: string,
      change: (name: string | null) => void,
      error: (error: unknown) => void,
    ) => {
      const handle = { change, error, closes: 0 };
      handles.push(handle);
      return {
        close: () => {
          handle.closes++;
        },
      };
    },
  };
  return {
    directory,
    handles,
    dependencies,
    errors,
    onError: (_error: unknown, phase: string) => {
      errors.push(phase);
    },
  };
}

test("100000 invalidations retain one running refresh and one follow-up", async (t) => {
  const f = fixture(),
    blocked = deferred(),
    entered = deferred(),
    followup = deferred();
  let calls = 0,
    active = 0,
    maxActive = 0;
  const lease = watchFileInvalidation(
    {
      filePath: join(f.directory, "account.json"),
      onError: f.onError,
      onInvalidate: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls === 1) {
            entered.resolve();
            await blocked.promise;
          } else followup.resolve();
        } finally {
          active--;
        }
      },
    },
    f.dependencies,
  );
  t.after(() => {
    blocked.resolve();
    lease.dispose();
  });
  await lease.ready;
  f.handles[0]!.change("account.json");
  await entered.promise;
  for (let i = 0; i < 100000; i++) f.handles[0]!.change("account.json");
  assert.equal(calls, 1);
  blocked.resolve();
  await followup.promise;
  await tick();
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(f.errors, []);
});

test("directory handles are shared, filenames filtered, and final dispose fences the old generation", async (t) => {
  const f = fixture();
  let a = 0,
    b = 0,
    c = 0;
  const open = (name: string, run: () => void) =>
    watchFileInvalidation(
      {
        filePath: join(f.directory, name),
        onInvalidate: async () => {
          run();
        },
        onError: f.onError,
      },
      f.dependencies,
    );
  const first = open("a.json", () => a++),
    second = open("b.json", () => b++),
    third = open("a.json", () => c++);
  t.after(() => {
    first.dispose();
    second.dispose();
    third.dispose();
  });
  await Promise.all([first.ready, second.ready, third.ready]);
  assert.equal(f.handles.length, 1);
  for (let i = 0; i < 100000; i++) f.handles[0]!.change("unrelated.tmp");
  await tick();
  assert.deepEqual([a, b, c], [0, 0, 0]);
  f.handles[0]!.change("a.json");
  await tick();
  assert.deepEqual([a, b, c], [1, 0, 1]);
  first.dispose();
  f.handles[0]!.change(null);
  await tick();
  assert.deepEqual([a, b, c], [1, 1, 2]);
  assert.equal(f.handles[0]!.closes, 0);
  second.dispose();
  third.dispose();
  assert.equal(f.handles[0]!.closes, 1);
  const next = open("a.json", () => a++);
  t.after(() => next.dispose());
  await next.ready;
  assert.equal(f.handles.length, 2);
  f.handles[0]!.change("a.json");
  f.handles[0]!.error(new Error("old generation"));
  await tick();
  assert.equal(a, 1);
  assert.deepEqual(f.errors, []);
  f.handles[1]!.change("a.json");
  await tick();
  assert.equal(a, 2);
});

test("refresh failure is reported once until recovery and does not stop later invalidations", async (t) => {
  const f = fixture();
  let failed = true,
    calls = 0;
  const lease = watchFileInvalidation(
    {
      filePath: join(f.directory, "state.json"),
      onError: f.onError,
      onInvalidate: async () => {
        calls++;
        if (failed) throw new Error("fixture read failure");
      },
    },
    f.dependencies,
  );
  t.after(() => lease.dispose());
  await lease.ready;
  for (let i = 0; i < 3; i++) {
    f.handles[0]!.change("state.json");
    await tick();
  }
  assert.equal(calls, 3);
  assert.deepEqual(f.errors, ["refresh"]);
  failed = false;
  f.handles[0]!.change("state.json");
  await tick();
  failed = true;
  f.handles[0]!.change("state.json");
  await tick();
  assert.deepEqual(f.errors, ["refresh", "refresh"]);
  f.handles[0]!.error(new Error("fixture watch failure"));
  assert.equal(f.handles[0]!.closes, 1);
  assert.deepEqual(f.errors, ["refresh", "refresh", "watch"]);
  f.handles[0]!.change("state.json");
  await tick();
  assert.equal(calls, 5);
  lease.dispose();
  assert.equal(f.handles[0]!.closes, 1);
});

test("cancelling during directory preparation creates no late handle and cannot close a replacement", async (t) => {
  const f = fixture(),
    blocked = deferred();
  let starts = 0;
  const dependencies = {
    ...f.dependencies,
    createDirectory: async () => {
      if (++starts === 1) await blocked.promise;
    },
  };
  const options = {
    filePath: join(f.directory, "state.json"),
    onInvalidate: async () => {
      assert.fail("cancelled read");
    },
    onError: f.onError,
    initialRead: true,
  };
  const old = watchFileInvalidation(options, dependencies);
  old.dispose();
  const next = watchFileInvalidation({ ...options, initialRead: false }, dependencies);
  t.after(() => {
    blocked.resolve();
    old.dispose();
    next.dispose();
  });
  await next.ready;
  assert.equal(f.handles.length, 1);
  blocked.resolve();
  await old.ready;
  await tick();
  assert.equal(f.handles.length, 1);
  assert.equal(f.handles[0]!.closes, 0);
  assert.deepEqual(f.errors, []);
});

test("initial read is installed after watch; disposing one listener aborts only its pending refresh", async (t) => {
  const f = fixture(),
    blocked = deferred(),
    entered = deferred();
  let signal: AbortSignal | undefined;
  let published = 0,
    other = 0;
  const first = watchFileInvalidation(
    {
      filePath: join(f.directory, "state.json"),
      initialRead: true,
      onError: f.onError,
      onInvalidate: async (currentSignal) => {
        assert.equal(f.handles.length, 1);
        signal = currentSignal;
        entered.resolve();
        await blocked.promise;
        if (!currentSignal.aborted) published++;
      },
    },
    f.dependencies,
  );
  const second = watchFileInvalidation(
    {
      filePath: join(f.directory, "state.json"),
      onError: f.onError,
      onInvalidate: async () => {
        other++;
      },
    },
    f.dependencies,
  );
  t.after(() => {
    blocked.resolve();
    first.dispose();
    second.dispose();
  });
  await entered.promise;
  await second.ready;
  first.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(f.handles[0]!.closes, 0);
  f.handles[0]!.change("state.json");
  blocked.resolve();
  await tick();
  assert.equal(published, 0);
  assert.equal(other, 1);
});

test("initialization failures settle readiness, report once, and leave no active handle", async () => {
  for (const failure of ["mkdir", "watch"] as const) {
    const f = fixture();
    const lease = watchFileInvalidation(
      {
        filePath: join(f.directory, "state.json"),
        onError: f.onError,
        onInvalidate: async () => {},
      },
      {
        createDirectory: async () => {
          if (failure === "mkdir") throw new Error("fixture");
        },
        watchDirectory: () => {
          throw new Error("fixture");
        },
      },
    );
    await lease.ready;
    assert.deepEqual(f.errors, ["watch"]);
    lease.dispose();
  }
});

test("different directories and case-sensitive filenames do not share invalidations", async (t) => {
  const f = fixture();
  let a = 0,
    b = 0;
  const first = watchFileInvalidation(
    {
      filePath: join(f.directory, "one", "state.json"),
      onError: f.onError,
      onInvalidate: async () => {
        a++;
      },
    },
    f.dependencies,
  );
  const second = watchFileInvalidation(
    {
      filePath: join(f.directory, "two", "state.json"),
      onError: f.onError,
      onInvalidate: async () => {
        b++;
      },
    },
    f.dependencies,
  );
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  await Promise.all([first.ready, second.ready]);
  assert.equal(f.handles.length, 2);
  f.handles[0]!.change("STATE.JSON");
  await tick();
  assert.equal(a, process.platform === "win32" ? 1 : 0);
  assert.equal(b, 0);
  f.handles[1]!.change("state.json");
  await tick();
  assert.equal(b, 1);
});

test("a synchronous watch startup error still closes the returned handle and aborts its subscriber", async () => {
  const f = fixture();
  let closes = 0;
  const lease = watchFileInvalidation(
    {
      filePath: join(f.directory, "state.json"),
      initialRead: true,
      onError: f.onError,
      onInvalidate: async () => {
        assert.fail("failed watch cannot read");
      },
    },
    {
      createDirectory: async () => {},
      watchDirectory: (_directory, _change, error) => {
        error(new Error("fixture startup"));
        return {
          close: () => {
            closes++;
          },
        };
      },
    },
  );
  await lease.ready;
  lease.dispose();
  assert.equal(closes, 1);
  assert.deepEqual(f.errors, ["watch"]);
});

test(
  "actual parent-directory watch survives atomic replacement and target delete/recreate",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "watch-atomic-")),
      filePath = join(directory, "state.json");
    await writeFile(filePath, "first");
    const waits = new Map<string, () => void>();
    const expectValue = (value: string) =>
      new Promise<void>((resolve) => waits.set(value, resolve));
    const first = expectValue("first");
    const errors: unknown[] = [];
    const lease = watchFileInvalidation({
      filePath,
      initialRead: true,
      onError: (error) => {
        errors.push(error);
      },
      onInvalidate: async (signal) => {
        const value = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "missing";
          throw error;
        });
        if (!signal.aborted) waits.get(value)?.();
      },
    });
    t.after(async () => {
      lease.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    await first;
    const replacement = expectValue("second");
    await writeFile(join(directory, "replacement.tmp"), "second");
    await rename(join(directory, "replacement.tmp"), filePath);
    await replacement;
    const missing = expectValue("missing");
    await unlink(filePath);
    await missing;
    const recreated = expectValue("third");
    await writeFile(filePath, "third");
    await recreated;
    assert.deepEqual(errors, []);
  },
);
