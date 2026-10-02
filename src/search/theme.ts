import type { Database } from 'bun:sqlite';
import {
  type Mode,
  type Row,
  type SearchOptions,
  type SourceFilter,
  search,
} from './search';

// Reciprocal rank fusion constant. 60 is the value from the original RRF
// paper; it keeps one list's top hit from outweighing broad agreement.
const RRF_K = 60;

// Weight scales a signal's RRF score; depth is how many candidates it adds.
// The vibe signals carry a theme's mood and count double. Lyrics and Genius
// notes match common words almost anywhere ("fall", "rain"), so only their
// best hits count. Genius notes also hold release dates and chart trivia,
// where month and season words match by accident.
const SIGNALS = {
  vibe: { weight: 2, depth: 200 },
  'artist-vibe': { weight: 2, depth: 200 },
  title: { weight: 1, depth: 200 },
  lyrics: { weight: 1, depth: 50 },
  meaning: { weight: 0.5, depth: 50 },
  tag: { weight: 1, depth: 200 },
} satisfies Partial<Record<Mode, { weight: number; depth: number }>>;

type SignalMode = keyof typeof SIGNALS;

export interface ThemeOptions {
  readonly vibe?: string;
  readonly vector?: Float32Array;
  /**
   * Genres and sound for the artist vibe search. Artist embeddings come
   * from tags, which name genres and instruments but rarely moods or
   * seasons, so "autumn" finds noise where "indie folk, acoustic" works.
   * Without it, the artist search uses the vibe.
   */
  readonly sound?: string;
  readonly soundVector?: Float32Array;
  readonly words: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly excludeTags?: ReadonlyArray<string>;
  readonly source: SourceFilter;
  readonly minPlays: number;
  readonly limit: number;
}

export interface ThemeRow extends Row {
  readonly score: number;
  /** Which searches found the track, such as "title:magic" or "vibe". */
  readonly signals: ReadonlyArray<string>;
}

// No single signal is reliable: tags are sparse, lyrics and Genius notes
// cover part of the library, titles are literal, and track embeddings drift
// toward title words. A track that several signals agree on ranks first.
//
// One word searched in title, lyrics and Genius notes is one piece of
// evidence, not three, so a word's fields share a group and only the best
// of them counts. Otherwise a song that mentions "rain" in passing outranks
// one the vibe search found.
export const themeSearch = (db: Database, options: ThemeOptions) => {
  const lists: Array<{
    signal: string;
    group: string;
    weight: number;
    rows: Row[];
  }> = [];
  const run = (
    mode: SignalMode,
    query: string,
    group: string,
    vector?: Float32Array,
  ) => {
    const { weight, depth } = SIGNALS[mode];
    const searchOptions: SearchOptions = {
      mode,
      query,
      limit: depth,
      source: options.source,
      minPlays: options.minPlays,
      substring: false,
      excludeTags: options.excludeTags,
      vector,
    };
    const signal = mode.endsWith('vibe') ? mode : `${mode}:${query}`;
    lists.push({ signal, group, weight, rows: search(db, searchOptions) });
  };

  if (options.vector) run('vibe', options.vibe ?? '', 'vibe', options.vector);
  const artistVector = options.soundVector ?? options.vector;
  if (artistVector) {
    run(
      'artist-vibe',
      options.sound ?? options.vibe ?? '',
      'artist-vibe',
      artistVector,
    );
  }
  for (const word of options.words) {
    for (const mode of ['title', 'lyrics', 'meaning'] as const) {
      run(mode, word, `word:${word}`);
    }
  }
  for (const tag of options.tags) run('tag', tag, `tag:${tag}`);

  interface Fused {
    row: Row;
    groups: Map<string, number>;
    signals: string[];
  }
  const fused = new Map<number, Fused>();
  for (const { signal, group, weight, rows } of lists) {
    rows.forEach((row, rank) => {
      const entry: Fused = fused.get(row.id) ?? {
        row,
        groups: new Map(),
        signals: [],
      };
      const score = weight / (RRF_K + rank + 1);
      entry.groups.set(group, Math.max(entry.groups.get(group) ?? 0, score));
      entry.signals.push(signal);
      // Keep a lyrics snippet if any signal produced one.
      if (row.match && !entry.row.match)
        entry.row = { ...entry.row, match: row.match };
      fused.set(row.id, entry);
    });
  }

  return [...fused.values()]
    .map((entry) => ({
      ...entry,
      score: [...entry.groups.values()].reduce((sum, s) => sum + s, 0),
    }))
    .sort((a, b) => b.score - a.score || b.row.plays - a.row.plays)
    .slice(0, options.limit)
    .map(
      ({ row, score, signals }): ThemeRow => ({
        ...row,
        score: Number(score.toFixed(4)),
        signals,
      }),
    );
};
