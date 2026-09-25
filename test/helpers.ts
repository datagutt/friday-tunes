import { afterEach, expect, spyOn } from 'bun:test';
import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  TestClock,
  TestContext,
} from 'effect';

export const SQLITE_LIB = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';

export interface Step {
  /** Substring the request URL must contain. */
  readonly url: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
}

// Answers fetch calls from a fixed script, in order, and fails the test if
// a request does not match or a scripted step is never used.
export const scriptFetch = (steps: ReadonlyArray<Step>) => {
  const queue = [...steps];
  const seen: string[] = [];
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const step = queue.shift();
    if (!step) throw new Error(`Unexpected request: ${url}`);
    expect(url).toContain(step.url);
    return new Response(
      step.json === undefined ? '' : JSON.stringify(step.json),
      { status: step.status ?? 200, headers: step.headers },
    );
  }) as typeof fetch);
  afterEach(() => spy.mockRestore());
  return {
    seen,
    done: () => expect(queue.map((s) => s.url)).toEqual([]),
  };
};

export const testConfig = (values: Record<string, string>) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map(Object.entries({ SQLITE_LIB, ...values }))),
  );

// Runs an effect under the test clock and moves time forward in steps, so
// retry and rate-limit waits finish at once.
export const runWithClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(effect);
    for (let i = 0; i < 200; i++) {
      yield* TestClock.adjust('1 second');
      if (yield* fiber.poll.pipe(Effect.map((o) => o._tag === 'Some'))) break;
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
