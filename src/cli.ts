import { Args, Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import {
  type ConfigError,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
} from 'effect';
import { Db, DbLive } from './db/db';
import { embed } from './embed/ollama';
import { install, runNow, uninstall } from './schedule';
import { formatRow, MODES, SOURCE_FILTERS, search } from './search/search';
import { stats } from './search/stats';
import { themeSearch } from './search/theme';
import { authorize } from './spotify/auth';
import { Spotify } from './spotify/client';
import { createPlaylist } from './spotify/playlist';
import { resolveTracks } from './spotify/resolve';
import { isStale, runSync, STEPS } from './sync';

const auth = Command.make('auth', {}, () =>
  authorize.pipe(Effect.zipRight(Console.log('Spotify authorized.'))),
).pipe(Command.withDescription('Log in to Spotify in the browser.'));

const sync = Command.make(
  'sync',
  {
    full: Options.boolean('full').pipe(
      Options.withDescription(
        'Re-read everything instead of only what changed since the last sync.',
      ),
    ),
    steps: Options.choice('step', STEPS).pipe(
      Options.repeated,
      Options.withDescription('Run only these steps. Repeat for several.'),
    ),
  },
  ({ full, steps }) =>
    runSync({ full, steps }).pipe(
      // Each failed step is already logged with its reason.
      Effect.catchTag('SyncFailed', (e) =>
        Console.error(e.message).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription('Update the local index.'));

const syncIfStale = (noSync: boolean) =>
  Effect.gen(function* () {
    if (noSync || !(yield* isStale)) return;
    yield* runSync({ full: false, steps: [] }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`quick sync skipped: ${error.message}`),
      ),
    );
  });

const commonSearchOptions = {
  limit: Options.integer('limit').pipe(Options.withDefault(50)),
  source: Options.choice('source', SOURCE_FILTERS).pipe(
    Options.withDefault('any' as const),
  ),
  minPlays: Options.integer('min-plays').pipe(Options.withDefault(0)),
  json: Options.boolean('json'),
  noSync: Options.boolean('no-sync').pipe(
    Options.withDescription('Skip the automatic quick sync of a stale index.'),
  ),
};

const searchCommand = Command.make(
  'search',
  {
    mode: Args.choice(
      MODES.map((m) => [m, m] as [string, (typeof MODES)[number]]),
    ),
    query: Args.text({ name: 'query' }).pipe(Args.atLeast(1)),
    ...commonSearchOptions,
    substring: Options.boolean('substring').pipe(
      Options.withDescription(
        'Title mode: match inside words ("love" finds "lovely").',
      ),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      yield* syncIfStale(options.noSync);
      const db = yield* Db;
      const query = options.query.join(' ');
      const vector =
        options.mode === 'vibe' ? (yield* embed([query]))[0] : undefined;
      const rows = search(db, { ...options, query, vector });
      yield* Console.log(
        options.json
          ? JSON.stringify(rows, null, 2)
          : rows.map(formatRow).join('\n') || 'No matches.',
      );
    }),
).pipe(Command.withDescription('Search the index.'));

const themeCommand = Command.make(
  'theme',
  {
    vibe: Options.text('vibe').pipe(
      Options.optional,
      Options.withDescription('Describe the mood for the embedding search.'),
    ),
    words: Options.text('word').pipe(
      Options.repeated,
      Options.withDescription(
        'Match in titles and lyrics. Repeat for several.',
      ),
    ),
    tags: Options.text('tag').pipe(
      Options.repeated,
      Options.withDescription('Match in Last.fm tags. Repeat for several.'),
    ),
    ...commonSearchOptions,
  },
  (options) =>
    Effect.gen(function* () {
      yield* syncIfStale(options.noSync);
      const db = yield* Db;
      const vibe = Option.getOrUndefined(options.vibe);
      const vector = vibe ? (yield* embed([vibe]))[0] : undefined;
      const rows = themeSearch(db, { ...options, vibe, vector });
      yield* Console.log(
        options.json
          ? JSON.stringify(rows, null, 2)
          : rows
              .map(
                (r) => `${formatRow(r)}\n        via ${r.signals.join(', ')}`,
              )
              .join('\n') || 'No matches.',
      );
    }),
).pipe(
  Command.withDescription(
    'Combine vibe, title, lyrics and tag searches into one ranked list.',
  ),
);

const statsCommand = Command.make('stats', {}, () =>
  Effect.flatMap(Db, (db) => Console.log(stats(db))),
).pipe(Command.withDescription('Show index coverage and sync ages.'));

const trackIds = Args.integer({ name: 'track-id' }).pipe(Args.atLeast(1));

const resolve = Command.make('resolve', { ids: trackIds }, ({ ids }) =>
  resolveTracks(ids).pipe(
    Effect.flatMap((resolved) =>
      Console.log(JSON.stringify(Object.fromEntries(resolved), null, 2)),
    ),
    Effect.provide(Spotify.Default),
  ),
).pipe(
  Command.withDescription(
    'Find Spotify IDs for indexed tracks that have none (scrobble-only tracks).',
  ),
);

const playlistCreate = Command.make(
  'create',
  {
    name: Options.text('name'),
    description: Options.text('description').pipe(Options.withDefault('')),
    ids: trackIds,
  },
  (options) =>
    createPlaylist({ ...options, trackIds: options.ids }).pipe(
      Effect.flatMap((result) =>
        Console.log(
          [
            `Created ${result.url} with ${result.added} tracks.`,
            ...(result.missing.length
              ? [`Not on Spotify: ${result.missing.join('; ')}`]
              : []),
          ].join('\n'),
        ),
      ),
      Effect.provide(Spotify.Default),
    ),
).pipe(
  Command.withDescription(
    'Create a private Spotify playlist from indexed track IDs.',
  ),
);

const playlist = Command.make('playlist').pipe(
  Command.withSubcommands([playlistCreate]),
);

const scheduleCommand = (
  name: string,
  description: string,
  effect: Effect.Effect<string, Error | ConfigError.ConfigError>,
) =>
  Command.make(name, {}, () => Effect.flatMap(effect, Console.log)).pipe(
    Command.withDescription(description),
  );

const schedule = Command.make('schedule').pipe(
  Command.withSubcommands([
    scheduleCommand(
      'install',
      'Install the launchd jobs: full sync Fridays 13:00, Spotify and Genius trickle hourly.',
      install,
    ),
    scheduleCommand('uninstall', 'Remove the launchd jobs.', uninstall),
    scheduleCommand('run', 'Start the weekly full sync now.', runNow),
  ]),
);

const root = Command.make('ft').pipe(
  Command.withSubcommands([
    auth,
    sync,
    searchCommand,
    themeCommand,
    statsCommand,
    resolve,
    playlist,
    schedule,
  ]),
);

const cli = Command.run(root, { name: 'friday-tunes', version: '0.1.0' });

// Logs go to stderr so `--json` output on stdout stays parseable.
const StderrLogger = Logger.replace(
  Logger.defaultLogger,
  Logger.prettyLogger({ stderr: true }),
);

cli(process.argv).pipe(
  Effect.provide(Layer.mergeAll(BunContext.layer, DbLive, StderrLogger)),
  (program) => BunRuntime.runMain(program, { disablePrettyLogger: true }),
);
