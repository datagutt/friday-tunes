import { Args, Command, Options } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Console, Effect, Layer, Logger } from 'effect';
import { Db, DbLive } from './db/db';
import { formatRow, MODES, SOURCE_FILTERS, search } from './search/search';
import { stats } from './search/stats';
import { authorize } from './spotify/auth';
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
  ({ full, steps }) => runSync({ full, steps }),
).pipe(Command.withDescription('Update the local index.'));

const searchCommand = Command.make(
  'search',
  {
    mode: Args.choice(
      MODES.map((m) => [m, m] as [string, (typeof MODES)[number]]),
    ),
    query: Args.text({ name: 'query' }).pipe(Args.atLeast(1)),
    limit: Options.integer('limit').pipe(Options.withDefault(50)),
    source: Options.choice('source', SOURCE_FILTERS).pipe(
      Options.withDefault('any' as const),
    ),
    minPlays: Options.integer('min-plays').pipe(Options.withDefault(0)),
    substring: Options.boolean('substring').pipe(
      Options.withDescription(
        'Title mode: match inside words ("love" finds "lovely").',
      ),
    ),
    json: Options.boolean('json'),
    noSync: Options.boolean('no-sync').pipe(
      Options.withDescription(
        'Skip the automatic quick sync of a stale index.',
      ),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      if (!options.noSync && (yield* isStale)) {
        yield* runSync({ full: false, steps: [] }).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`quick sync skipped: ${error.message}`),
          ),
        );
      }
      const db = yield* Db;
      const rows = search(db, { ...options, query: options.query.join(' ') });
      yield* Console.log(
        options.json
          ? JSON.stringify(rows, null, 2)
          : rows.map(formatRow).join('\n') || 'No matches.',
      );
    }),
).pipe(Command.withDescription('Search the index.'));

const statsCommand = Command.make('stats', {}, () =>
  Effect.flatMap(Db, (db) => Console.log(stats(db))),
).pipe(Command.withDescription('Show index coverage and sync ages.'));

const root = Command.make('ft').pipe(
  Command.withSubcommands([auth, sync, searchCommand, statsCommand]),
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
