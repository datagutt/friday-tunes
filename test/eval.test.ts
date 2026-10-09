import type { Database } from 'bun:sqlite';
import { beforeAll, expect, test } from 'bun:test';
import { openDatabase } from '../src/db/db';
import { upsertTrack } from '../src/db/library';
import {
  type EvalCase,
  formatReport,
  resolveEvalTrack,
  scoreCase,
} from '../src/search/eval';
import type { ThemeRow } from '../src/search/theme';
import { SQLITE_LIB } from './helpers';

let db: Database;
let war: number;
let peace: number;

beforeAll(() => {
  db = openDatabase(':memory:', SQLITE_LIB);
  war = upsertTrack(db, {
    title: 'War - Remastered 2003',
    artists: [{ name: 'Edwin Starr' }],
    spotifyId: '3ZFBeIyP41HhnALjxWy1pR',
  });
  peace = upsertTrack(db, {
    title: 'Give Peace a Chance',
    artists: [{ name: 'Plastic Ono Band' }, { name: 'John Lennon' }],
  });
  upsertTrack(db, {
    title: '21 Guns',
    artists: [{ name: 'Green Day' }],
  });
});

test('answer key tracks resolve by Spotify link, ID, or title and any artist', () => {
  expect(
    resolveEvalTrack(
      db,
      'https://open.spotify.com/track/3ZFBeIyP41HhnALjxWy1pR?si=abc',
    ),
  ).toBe(war);
  expect(resolveEvalTrack(db, 'spotify:track:3ZFBeIyP41HhnALjxWy1pR')).toBe(
    war,
  );
  expect(resolveEvalTrack(db, { title: 'War', artist: 'Edwin Starr' })).toBe(
    war,
  );
  expect(
    resolveEvalTrack(db, {
      title: 'Give Peace A Chance',
      artist: 'John Lennon',
    }),
  ).toBe(peace);
  expect(
    resolveEvalTrack(db, { title: 'Imagine', artist: 'John Lennon' }),
  ).toBeUndefined();
});

test('recall counts resolved tracks within each cut-off', () => {
  const evalCase: EvalCase = {
    theme: 'Peace',
    words: [],
    tags: [],
    excludeTags: [],
    source: 'any',
    tracks: [
      { title: 'War', artist: 'Edwin Starr' },
      { title: 'Give Peace a Chance', artist: 'John Lennon' },
      { title: '21 Guns', artist: 'Green Day' },
      { title: 'Imagine', artist: 'John Lennon' },
    ],
  };
  // War ranks first, Give Peace a Chance 30th, 21 Guns not at all.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: i === 0 ? war : i === 29 ? peace : 1000 + i,
  })) as unknown as ThemeRow[];
  const result = scoreCase(db, evalCase, rows);
  expect(result.resolved).toBe(3);
  expect(result.found).toEqual({ 20: 1, 50: 2 });
  expect(result.unresolved).toEqual(['Imagine - John Lennon']);
  expect(result.misses).toEqual([{ track: '21 Guns - Green Day' }]);
  expect(formatReport([result])).toContain(
    'mean recall over 1 themes: @20 33%, @50 67%',
  );
});
