import path from 'node:path';
import { Args, Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import {
  type ConfigError,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  Schema,
} from 'effect';
import { dataDir } from './config';
import { Db, DbLive } from './db/db';
import { embed } from './embed/ollama';
import { install, runNow, uninstall } from './schedule';
import { EvalFile, formatReport, runEval } from './search/eval';
import {
  formatRow,
  MODES,
  SOURCE_FILTERS,
  search,
  VIBE_MODES,
} from './search/search';
import { stats } from './search/stats';
import { themeSearch, themeVectors } from './search/theme';
import { authorize } from './spotify/auth';
import { Spotify } from './spotify/client';
import {
  changePlaylist,
  createPlaylist,
  type Missing,
} from './spotify/playlist';
import { isStale, runSync, STEPS } from './sync';
import { setManualVoice, showVoice } from './voices/manual';
import { VOCALS, VOICES, type Voice } from './voices/voices';

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
    summaryMinutes: Options.integer('summary-minutes').pipe(
      Options.optional,
      Options.withDescription(
        'Stop writing summaries after this many minutes. Without it, the summary step runs until every song is done.',
      ),
    ),
  },
  ({ full, steps, summaryMinutes }) =>
    runSync({
      full,
      steps,
      summaryMinutes: Option.getOrUndefined(summaryMinutes),
    }).pipe(
      // Each failed step is already logged with its reason.
      // The hourly job often starts while another sync runs; that is a skip.
      Effect.catchTag('SyncBusy', (e) =>
        Effect.logInfo(`sync skipped: ${e.message}`),
      ),
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
  excludeTags: Options.text('exclude-tag').pipe(
    Options.repeated,
    Options.withDescription(
      'Leave out tracks whose own or artist tags match. Repeat for several.',
    ),
  ),
  clean: Options.boolean('clean').pipe(
    Options.withDescription(
      'Leave out songs Spotify marks explicit. Songs without a Spotify version are kept.',
    ),
  ),
  vocals: Options.choice('vocals', VOCALS).pipe(
    Options.optional,
    Options.withDescription(
      'Only songs sung by women and men together (mixed), or by women or men only. Songs with unknown singers are left out.',
    ),
  ),
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
      const vector = VIBE_MODES.has(options.mode)
        ? (yield* embed([query]))[0]
        : undefined;
      const rows = search(db, {
        ...options,
        query,
        vector,
        vocals: Option.getOrUndefined(options.vocals),
      });
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
      Options.withDescription(
        'Describe the mood for the track embedding search.',
      ),
    ),
    avoid: Options.text('avoid').pipe(
      Options.repeated,
      Options.withDescription(
        'A neighbouring theme to keep out, such as "christmas" for Halloween. Drops tracks closer to it than to the vibe. Repeat for several.',
      ),
    ),
    sound: Options.text('sound').pipe(
      Options.optional,
      Options.withDescription(
        'Genres and sound for the artist embedding search, such as "indie folk, acoustic". Without it, the artist search does not run.',
      ),
    ),
    words: Options.text('word').pipe(
      Options.repeated,
      Options.withDescription(
        'Match in titles, lyrics and Genius notes. Repeat for several.',
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
      const sound = Option.getOrUndefined(options.sound);
      const vectors = yield* themeVectors(vibe, sound, options.avoid);
      const rows = themeSearch(db, {
        ...options,
        vibe,
        sound,
        vocals: Option.getOrUndefined(options.vocals),
        ...vectors,
      });
      yield* Console.log(
        options.json
          ? JSON.stringify(rows, null, 2)
          : rows
              .map((r) =>
                [
                  formatRow(r),
                  `        via ${r.signals.join(', ')}`,
                  ...(r.versions?.length
                    ? [
                        `        also ${r.versions.map((v) => `${v.artists} (${v.id})`).join(', ')}`,
                      ]
                    : []),
                ].join('\n'),
              )
              .join('\n') || 'No matches.',
      );
    }),
).pipe(
  Command.withDescription(
    'Combine vibe, artist vibe, word and tag searches into one ranked list.',
  ),
);

const evalCommand = Command.make(
  'eval',
  {
    file: Options.file('file').pipe(
      Options.optional,
      Options.withDescription(
        'Answer keys to score. Defaults to data/eval.json.',
      ),
    ),
  },
  ({ file }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const target = Option.isSome(file)
        ? file.value
        : path.join(yield* dataDir, 'eval.json');
      const json = yield* Effect.tryPromise(() => Bun.file(target).json());
      const cases = yield* Schema.decodeUnknown(EvalFile)(json);
      yield* Console.log(formatReport(yield* runEval(db, cases)));
    }),
).pipe(
  Command.withDescription(
    'Score ft theme against past themes: how many approved tracks rank in the top 20 and 50.',
  ),
);

const voiceCommand = Command.make(
  'voice',
  {
    artist: Args.text({ name: 'artist' }).pipe(
      Args.withDescription('Artist name, quoted if it has spaces.'),
    ),
    voice: Args.choice(
      [...VOICES, 'clear'].map((v) => [v, v] as [string, Voice | 'clear']),
      { name: 'voice' },
    ).pipe(Args.optional),
  },
  ({ artist, voice }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const report = Option.match(voice, {
        onNone: () => showVoice(db, artist),
        onSome: (v) => setManualVoice(db, artist, v === 'clear' ? null : v),
      });
      yield* Console.log(report);
    }),
).pipe(
  Command.withDescription(
    "Show where an artist's voice comes from, or set it by hand: female, male, mixed (a band where both sing), nonbinary, or clear.",
  ),
);

const statsCommand = Command.make('stats', {}, () =>
  Effect.flatMap(Db, (db) => Console.log(stats(db))),
).pipe(Command.withDescription('Show index coverage and sync ages.'));

const trackIds = Args.integer({ name: 'track-id' }).pipe(Args.atLeast(1));

const formatMissing = (missing: ReadonlyArray<Missing>) =>
  missing.map((m) => {
    const others = m.alternatives.length
      ? `; other versions: ${m.alternatives.map((a) => `${a.artists} (${a.id})`).join(', ')}`
      : '';
    return `Not on Spotify: ${m.title} - ${m.artists} (${m.id})${others}`;
  });

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
            `Created ${result.url} with ${result.count} tracks.`,
            ...formatMissing(result.missing),
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

const playlistChange = (action: 'add' | 'remove') =>
  Command.make(
    action,
    {
      playlist: Args.text({ name: 'playlist' }).pipe(
        Args.withDescription('Playlist link, URI or ID.'),
      ),
      ids: trackIds,
    },
    ({ playlist, ids }) =>
      changePlaylist({ playlist, action, trackIds: ids }).pipe(
        Effect.flatMap((result) =>
          Console.log(
            [
              `${action === 'add' ? 'Added' : 'Removed'} ${result.count} tracks ${action === 'add' ? 'to' : 'from'} ${result.url}.`,
              ...formatMissing(result.missing),
            ].join('\n'),
          ),
        ),
        Effect.provide(Spotify.Default),
      ),
  ).pipe(
    Command.withDescription(
      action === 'add'
        ? 'Add indexed track IDs to the end of a playlist.'
        : 'Remove indexed track IDs from a playlist.',
    ),
  );

const playlist = Command.make('playlist').pipe(
  Command.withSubcommands([
    playlistCreate,
    playlistChange('add'),
    playlistChange('remove'),
  ]),
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
    evalCommand,
    statsCommand,
    voiceCommand,
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
