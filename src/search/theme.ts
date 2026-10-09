import type { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { embed } from '../embed/ollama';
import { songKey } from '../normalize';
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

// A playlist is played to a room of coworkers, so a song the user knows
// beats an equally fitting one they never listened to. The boost grows
// with the log of plays and stays small next to the signals: 75 plays add
// about a third, so fit still decides. A track that is neither liked nor
// played usually came in with an imported playlist or an artist catalog.
const PLAYS_BOOST = 0.08;
const LIKED_BOOST = 0.1;
const UNPLAYED = 0.9;

export const listeningBoost = (row: Pick<Row, 'plays' | 'sources'>) => {
  const liked = row.sources.includes('liked');
  if (row.plays === 0 && !liked) return UNPLAYED;
  return 1 + PLAYS_BOOST * Math.log1p(row.plays) + (liked ? LIKED_BOOST : 0);
};

export interface ThemeOptions {
  readonly vibe?: string;
  readonly vector?: Float32Array;
  /**
   * Genres and sound for the artist vibe search. Artist embeddings come
   * from tags, which name genres and instruments but rarely moods or
   * seasons, so "autumn" finds noise where "indie folk, acoustic" works.
   * Without it, the artist search does not run.
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

// One embedding call for both queries.
export const themeVectors = (vibe?: string, sound?: string) =>
  Effect.gen(function* () {
    const queries = [vibe, sound].filter((q) => q !== undefined);
    const vectors = queries.length ? yield* embed(queries) : [];
    return {
      vector: vibe ? vectors[0] : undefined,
      soundVector: sound ? vectors[vibe ? 1 : 0] : undefined,
    };
  });

export interface ThemeVersion {
  readonly id: number;
  readonly title: string;
  readonly artists: string;
  readonly plays: number;
  readonly sources: ReadonlyArray<string>;
}

export interface ThemeRow extends Row {
  readonly score: number;
  /** Which searches found the track, such as "title:magic" or "vibe". */
  readonly signals: ReadonlyArray<string>;
  /** Lower ranked covers and versions of the same song, if any. */
  readonly versions?: ReadonlyArray<ThemeVersion>;
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
    vectors: Pick<SearchOptions, 'vector' | 'trackVector'> = {},
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
      ...vectors,
    };
    const signal = mode.endsWith('vibe') ? mode : `${mode}:${query}`;
    lists.push({ signal, group, weight, rows: search(db, searchOptions) });
  };

  if (options.vector) {
    run('vibe', options.vibe ?? '', 'vibe', { vector: options.vector });
  }
  // Artists are found by how they sound and contribute the tracks closest
  // to the vibe. Without a sound there is nothing to match artists on:
  // artist tags name genres, so a subject like "peace" lands on arbitrary
  // artists.
  if (options.soundVector) {
    run('artist-vibe', options.sound ?? '', 'artist-vibe', {
      vector: options.soundVector,
      trackVector: options.vector,
    });
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

  // A song often appears as the original, covers and live versions. Only
  // the best ranked one takes a place in the list; the others ride along,
  // so a playlist does not get the same song three times but the choice
  // stays visible.
  const songs = new Map<string, { row: ThemeRow; versions: ThemeVersion[] }>();
  const ranked = [...fused.values()]
    .map((entry) => ({
      ...entry,
      score:
        [...entry.groups.values()].reduce((sum, s) => sum + s, 0) *
        listeningBoost(entry.row),
    }))
    .sort((a, b) => b.score - a.score || b.row.plays - a.row.plays);
  for (const { row, score, signals } of ranked) {
    const key = songKey(row.title);
    const song = songs.get(key);
    if (song) {
      const { id, title, artists, plays, sources } = row;
      song.versions.push({ id, title, artists, plays, sources });
    } else if (songs.size < options.limit) {
      songs.set(key, {
        row: { ...row, score: Number(score.toFixed(4)), signals },
        versions: [],
      });
    }
  }
  return [...songs.values()].map(
    ({ row, versions }): ThemeRow =>
      versions.length ? { ...row, versions } : row,
  );
};
