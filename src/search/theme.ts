import type { Database } from 'bun:sqlite';
import {
  type Row,
  type SearchOptions,
  type SourceFilter,
  search,
} from './search';

// Reciprocal rank fusion constant. 60 is the value from the original RRF
// paper; it keeps one list's top hit from outweighing broad agreement.
const RRF_K = 60;
// Each signal contributes this many candidates before fusion.
const PER_SIGNAL = 200;

export interface ThemeOptions {
  readonly vibe?: string;
  readonly vector?: Float32Array;
  readonly words: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly source: SourceFilter;
  readonly minPlays: number;
  readonly limit: number;
}

export interface ThemeRow extends Row {
  readonly score: number;
  /** Which searches found the track, such as "title:magic" or "vibe". */
  readonly signals: ReadonlyArray<string>;
}

// No single signal is reliable: tags are sparse, lyrics cover about half the
// library, titles are literal, and embeddings drift toward title words. A
// track that several signals agree on ranks first.
export const themeSearch = (db: Database, options: ThemeOptions) => {
  const base: Omit<SearchOptions, 'mode' | 'query'> = {
    limit: PER_SIGNAL,
    source: options.source,
    minPlays: options.minPlays,
    substring: false,
  };
  const lists: Array<{ signal: string; rows: Row[] }> = [];
  if (options.vector) {
    lists.push({
      signal: 'vibe',
      rows: search(db, {
        ...base,
        mode: 'vibe',
        query: options.vibe ?? '',
        vector: options.vector,
      }),
    });
  }
  for (const word of options.words) {
    lists.push({
      signal: `title:${word}`,
      rows: search(db, { ...base, mode: 'title', query: word }),
    });
    lists.push({
      signal: `lyrics:${word}`,
      rows: search(db, { ...base, mode: 'lyrics', query: word }),
    });
  }
  for (const tag of options.tags) {
    lists.push({
      signal: `tag:${tag}`,
      rows: search(db, { ...base, mode: 'tag', query: tag }),
    });
  }

  const fused = new Map<
    number,
    { row: Row; score: number; signals: string[] }
  >();
  for (const { signal, rows } of lists) {
    rows.forEach((row, rank) => {
      const entry = fused.get(row.id) ?? { row, score: 0, signals: [] };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.signals.push(signal);
      // Keep a lyrics snippet if any signal produced one.
      if (row.match && !entry.row.match)
        entry.row = { ...entry.row, match: row.match };
      fused.set(row.id, entry);
    });
  }

  return [...fused.values()]
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
