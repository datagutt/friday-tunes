import { type Duration, Effect } from 'effect';

// Services without a published rate limit (Genius) or with a strict one
// (MusicBrainz) get a fixed number of paced calls per run, so the hourly
// job fills data in slowly instead of tripping a block.
export const makeBudget = (calls: number, pace: Duration.DurationInput) => {
  let used = 0;
  return {
    canAfford: (n: number) => used + n <= calls,
    get used() {
      return used;
    },
    spend: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      used++;
      return Effect.zipLeft(effect, Effect.sleep(pace));
    },
  };
};

export type Budget = ReturnType<typeof makeBudget>;
