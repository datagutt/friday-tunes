import type { Database } from 'bun:sqlite';
import { Effect, Schema } from 'effect';
import { matchKey, normalizeArtist, normalizeTitle } from '../normalize';
import { SOURCE_FILTERS } from './search';
import { type ThemeRow, themeSearch, themeVectors } from './theme';

// An answer key: a past theme, the `ft theme` arguments an agent would pass
// for it, and the tracks that made the final playlist. Weights and embedding
// text are tuned against how many of those tracks the search ranks high.

// A Spotify track link or ID, or a title and artist.
const EvalTrack = Schema.Union(
  Schema.String,
  Schema.Struct({ title: Schema.String, artist: Schema.String }),
);
type EvalTrack = typeof EvalTrack.Type;

const strings = Schema.optionalWith(Schema.Array(Schema.String), {
  default: () => [],
});

export const EvalCase = Schema.Struct({
  theme: Schema.String,
  vibe: Schema.optional(Schema.String),
  sound: Schema.optional(Schema.String),
  words: strings,
  tags: strings,
  excludeTags: strings,
  source: Schema.optionalWith(Schema.Literal(...SOURCE_FILTERS), {
    default: () => 'any' as const,
  }),
  tracks: Schema.Array(EvalTrack),
});
export type EvalCase = typeof EvalCase.Type;

export const EvalFile = Schema.Array(EvalCase);

// Recall is reported at these cut-offs. The search runs deeper than the
// largest so a miss can show how far off it was.
export const CUTOFFS = [20, 50] as const;
const DEPTH = 200;

const SPOTIFY_ID = /(?:track[/:])?([A-Za-z0-9]{22})(?:\?.*)?$/;

const label = (track: EvalTrack) =>
  typeof track === 'string' ? track : `${track.title} - ${track.artist}`;

export const resolveEvalTrack = (
  db: Database,
  track: EvalTrack,
): number | undefined => {
  if (typeof track === 'string') {
    const spotifyId = track.trim().match(SPOTIFY_ID)?.[1];
    if (!spotifyId) return undefined;
    return db
      .query<{ id: number }, [string, string]>(
        `select track_id as id from track_spotify_ids where spotify_id = ?
         union select id from tracks where spotify_id = ? limit 1`,
      )
      .get(spotifyId, spotifyId)?.id;
  }
  const exact = db
    .query<{ id: number }, [string]>(
      'select id from tracks where match_key = ?',
    )
    .get(matchKey(track.artist, track.title));
  if (exact) return exact.id;
  // The answer key may name a featured artist, or the index may list the
  // artists in another order.
  return db
    .query<{ id: number }, [string, string]>(
      `select t.id from tracks t
       join track_artists ta on ta.track_id = t.id
       join artists a on a.id = ta.artist_id
       where t.title_norm = ? and a.name_norm = ? limit 1`,
    )
    .get(normalizeTitle(track.title), normalizeArtist(track.artist))?.id;
};

export interface CaseResult {
  readonly theme: string;
  /** Answer key tracks the index holds, so a search could find them. */
  readonly resolved: number;
  readonly unresolved: ReadonlyArray<string>;
  readonly found: Readonly<Record<number, number>>;
  readonly misses: ReadonlyArray<{ track: string; rank?: number }>;
}

export const scoreCase = (
  db: Database,
  evalCase: EvalCase,
  rows: ReadonlyArray<ThemeRow>,
): CaseResult => {
  const rank = new Map(rows.map((row, i) => [row.id, i + 1]));
  const tracks = evalCase.tracks.map((track) => ({
    track: label(track),
    id: resolveEvalTrack(db, track),
  }));
  const resolved = tracks.flatMap(({ track, id }) =>
    id === undefined ? [] : [{ track, rank: rank.get(id) }],
  );
  const found = Object.fromEntries(
    CUTOFFS.map((k) => [
      k,
      resolved.filter((t) => t.rank !== undefined && t.rank <= k).length,
    ]),
  );
  const largest = CUTOFFS[CUTOFFS.length - 1] ?? 0;
  return {
    theme: evalCase.theme,
    resolved: resolved.length,
    unresolved: tracks.filter((t) => t.id === undefined).map((t) => t.track),
    found,
    misses: resolved.filter((t) => t.rank === undefined || t.rank > largest),
  };
};

const pct = (n: number, total: number) =>
  total ? `${Math.round((n / total) * 100)}%`.padStart(4) : '   -';

export const formatReport = (results: ReadonlyArray<CaseResult>) => {
  const lines = results.flatMap((r) => [
    `${CUTOFFS.map((k) => `@${k} ${pct(r.found[k] ?? 0, r.resolved)}`).join('  ')}  ${r.theme} (${r.resolved} tracks)`,
    ...r.misses.map(
      (m) =>
        `      missed ${m.track} ${m.rank ? `(rank ${m.rank})` : `(not in top ${DEPTH})`}`,
    ),
    ...r.unresolved.map((t) => `      not in index: ${t}`),
  ]);
  // Every theme counts the same, however many tracks its playlist had.
  const mean = (k: number) => {
    const scored = results.filter((r) => r.resolved > 0);
    const sum = scored.reduce((s, r) => s + (r.found[k] ?? 0) / r.resolved, 0);
    return scored.length ? `${Math.round((sum / scored.length) * 100)}%` : '-';
  };
  return [
    ...lines,
    '',
    `mean recall over ${results.length} themes: ${CUTOFFS.map((k) => `@${k} ${mean(k)}`).join(', ')}`,
  ].join('\n');
};

export const runEval = (db: Database, cases: ReadonlyArray<EvalCase>) =>
  Effect.forEach(cases, (evalCase) =>
    Effect.gen(function* () {
      const vectors = yield* themeVectors(evalCase.vibe, evalCase.sound);
      const rows = themeSearch(db, {
        ...evalCase,
        ...vectors,
        minPlays: 0,
        limit: DEPTH,
      });
      return scoreCase(db, evalCase, rows);
    }),
  );
