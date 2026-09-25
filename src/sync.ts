import { Effect } from 'effect';
import { Db } from './db/db';
import { getState, setState } from './db/library';
import { rebuildFts } from './search/fts';
import { Spotify } from './spotify/client';
import { syncLiked, syncPlaylists, syncRecent, syncTop } from './spotify/sync';

export const STEPS = ['spotify'] as const;
export type Step = (typeof STEPS)[number];

// Queries trigger a quick sync when the index is older than this, so a
// Friday search sees songs liked that morning.
export const STALE_AFTER_SECONDS = 12 * 3600;

const now = () => Math.floor(Date.now() / 1000);

const spotifyStep = (full: boolean) =>
  Effect.all([syncLiked(full), syncPlaylists(full), syncTop, syncRecent], {
    discard: true,
  }).pipe(Effect.provide(Spotify.Default));

const stepEffect = (step: Step, full: boolean) => {
  switch (step) {
    case 'spotify':
      return spotifyStep(full);
  }
};

export const runSync = (options: {
  readonly full: boolean;
  readonly steps: ReadonlyArray<Step>;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const steps = options.steps.length ? options.steps : STEPS;
    for (const step of steps) {
      yield* Effect.logInfo(`sync ${step}${options.full ? ' (full)' : ''}`);
      yield* stepEffect(step, options.full);
    }
    rebuildFts(db);
    // Only a run over every step counts as a sync of the whole index.
    if (steps.length === STEPS.length) {
      setState(db, 'sync.quick.at', now());
      if (options.full) setState(db, 'sync.full.at', now());
    }
  });

export const isStale = Effect.map(
  Db,
  (db) =>
    now() - Number(getState(db, 'sync.quick.at') ?? 0) > STALE_AFTER_SECONDS,
);
