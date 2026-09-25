import fs from 'node:fs';
import path from 'node:path';
import { Data, Effect } from 'effect';
import { dataDir } from './config';

export class SyncBusy extends Data.TaggedError('SyncBusy')<{
  readonly pid: number;
}> {
  override get message() {
    return `another sync is running (pid ${this.pid})`;
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const take = (file: string) =>
  Effect.suspend(() => {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return Effect.void;
    } catch {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (pid && isAlive(pid)) return Effect.fail(new SyncBusy({ pid }));
      // A crashed sync left its lock behind.
      fs.writeFileSync(file, String(process.pid));
      return Effect.void;
    }
  });

// One sync at a time: a multi-hour catalog run and a search's quick sync
// would otherwise both write, and the second would redo the first's work.
export const syncLock = Effect.gen(function* () {
  const dir = yield* dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sync.lock');
  yield* Effect.acquireRelease(take(file), () =>
    Effect.sync(() => fs.rmSync(file, { force: true })),
  );
});
