import { Data, Effect, Either } from 'effect';
import { Db } from './db/db';
import { getState, setState } from './db/library';
import { syncEmbeddings } from './embed/sync';
import { syncGenius } from './genius/sync';
import { syncCatalogs } from './lastfm/catalog';
import { LastFm } from './lastfm/client';
import { syncScrobbles, syncTags, syncTopArtists } from './lastfm/sync';
import { syncLock } from './lock';
import { syncLyrics } from './lyrics/sync';
import { rebuildFts } from './search/fts';
import { Spotify } from './spotify/client';
import { syncDiscographies } from './spotify/discography';
import {
  syncFollowed,
  syncLiked,
  syncPlaylists,
  syncRecent,
  syncTop,
} from './spotify/sync';

interface StepDef {
  readonly quick: boolean;
  readonly run: (
    full: boolean,
  ) => Effect.Effect<void, { readonly message: string }, Db>;
}

// `quick` steps run on every sync. The rest are slow enrichment that only
// a full sync (or an explicit --step) runs.
const STEP_DEFS = {
  spotify: {
    quick: true,
    run: (full: boolean) =>
      Effect.all([syncLiked(full), syncPlaylists(full), syncTop, syncRecent], {
        discard: true,
      }).pipe(Effect.provide(Spotify.Default)),
  },
  lastfm: {
    quick: true,
    run: (_full: boolean) =>
      Effect.all([syncScrobbles, syncTopArtists], { discard: true }).pipe(
        Effect.provide(LastFm.Default),
      ),
  },
  catalog: {
    quick: false,
    // The followed list comes from Spotify but only refines which artists
    // get a catalog, so a Spotify outage must not stop the Last.fm part.
    run: (_full: boolean) =>
      syncFollowed.pipe(
        Effect.provide(Spotify.Default),
        Effect.catchAll((e) =>
          Effect.logWarning(
            `followed artists skipped, using the stored list: ${e.message}`,
          ),
        ),
        Effect.zipRight(syncCatalogs.pipe(Effect.provide(LastFm.Default))),
      ),
  },
  discography: {
    quick: false,
    run: (_full: boolean) =>
      syncDiscographies.pipe(Effect.provide(Spotify.Default)),
  },
  tags: {
    quick: false,
    run: (_full: boolean) => syncTags.pipe(Effect.provide(LastFm.Default)),
  },
  lyrics: {
    quick: false,
    run: (_full: boolean) => Effect.scoped(syncLyrics),
  },
  genius: {
    quick: false,
    run: (_full: boolean) => syncGenius,
  },
  embed: {
    quick: false,
    run: (_full: boolean) => syncEmbeddings,
  },
} satisfies Record<string, StepDef>;

export type Step = keyof typeof STEP_DEFS;
export const STEPS = Object.keys(STEP_DEFS) as ReadonlyArray<Step>;

// Queries trigger a quick sync when the index is older than this, so a
// Friday search sees songs liked that morning.
export const STALE_AFTER_SECONDS = 12 * 3600;

export class SyncFailed extends Data.TaggedError('SyncFailed')<{
  readonly steps: ReadonlyArray<Step>;
}> {
  override get message() {
    return `sync failed for: ${this.steps.join(', ')}`;
  }
}

const now = () => Math.floor(Date.now() / 1000);

// A failing step does not stop the others: a missing Last.fm key should not
// block a Spotify sync.
export const runSync = (options: {
  readonly full: boolean;
  readonly steps: ReadonlyArray<Step>;
}) =>
  Effect.gen(function* () {
    yield* syncLock;
    const db = yield* Db;
    const explicit = options.steps.length > 0;
    const steps = explicit
      ? options.steps
      : STEPS.filter((s) => options.full || STEP_DEFS[s].quick);
    const failed: Step[] = [];

    for (const step of steps) {
      yield* Effect.logInfo(`sync ${step}${options.full ? ' (full)' : ''}`);
      const def: StepDef = STEP_DEFS[step];
      const result = yield* Effect.either(def.run(options.full));
      if (Either.isLeft(result)) {
        failed.push(step);
        yield* Effect.logError(`sync ${step} failed: ${result.left.message}`);
      }
    }
    rebuildFts(db);

    if (failed.length > 0) return yield* new SyncFailed({ steps: failed });
    if (!explicit) {
      setState(db, 'sync.quick.at', now());
      if (options.full) setState(db, 'sync.full.at', now());
    }
  }).pipe(Effect.scoped);

export const isStale = Effect.map(
  Db,
  (db) =>
    now() - Number(getState(db, 'sync.quick.at') ?? 0) > STALE_AFTER_SECONDS,
);
