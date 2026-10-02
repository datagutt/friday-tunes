import { type Duration, Effect } from 'effect';

// Genius publishes no rate limit, so every hourly run spends a fixed number
// of paced calls, shared by songs and artists.
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
