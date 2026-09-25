import type { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/db/db';
import { addSource, upsertTrack } from '../src/db/library';
import { rebuildFts } from '../src/search/fts';
import { ftsQuery, type SearchOptions, search } from '../src/search/search';

const SQLITE_LIB = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';
let db: Database;

const defaults: SearchOptions = {
  mode: 'title',
  query: '',
  limit: 50,
  source: 'any',
  minPlays: 0,
  substring: false,
};

const titles = (options: Partial<SearchOptions>) =>
  search(db, { ...defaults, ...options }).map((r) => r.title);

beforeAll(() => {
  db = openDatabase(':memory:', SQLITE_LIB);
  const magic = upsertTrack(db, {
    title: 'Magic',
    artists: [{ name: 'Pilot', spotifyId: 'pilot' }],
    spotifyId: 'magic',
    releaseYear: 1974,
  });
  addSource(db, magic, 'liked');
  const spell = upsertTrack(db, {
    title: 'Under Your Spell',
    artists: [{ name: 'Desire' }],
    releaseYear: 2009,
  });
  for (const ts of [1, 2, 3]) {
    db.query('insert into scrobbles (played_at, track_id) values (?, ?)').run(
      ts,
      spell,
    );
  }
  const magical = upsertTrack(db, {
    title: 'Magical Mystery Tour',
    artists: [{ name: 'The Beatles' }],
    releaseYear: 1967,
  });
  addSource(db, magical, 'catalog', 'beatles');
  upsertTrack(db, { title: 'Går ned', artists: [{ name: 'Synne Sørgjerd' }] });
  db.query(
    "insert into tags (entity, entity_id, tag, weight) values ('track', ?, 'dreamy', 100)",
  ).run(spell);
  db.query(
    "insert into lyrics (track_id, status, plain, fetched_at) values (?, 'hit', ?, 0)",
  ).run(magic, 'Oh oh oh it is magic\nYou know');
  rebuildFts(db);
});

describe('search', () => {
  test('title word match skips longer words, substring finds them', () => {
    expect(titles({ query: 'magic' })).toEqual(['Magic']);
    expect(titles({ query: 'magic', substring: true })).toEqual([
      'Magic',
      'Magical Mystery Tour',
    ]);
    expect(titles({ query: 'magic*' })).toHaveLength(2);
  });

  test('diacritics fold in FTS', () => {
    expect(titles({ query: 'gar' })).toEqual(['Går ned']);
    expect(titles({ mode: 'artist', query: 'sorgjerd' })).toEqual([]);
    expect(titles({ mode: 'artist', query: 'sørgjerd' })).toEqual(['Går ned']);
  });

  test('source filters and play counts', () => {
    expect(titles({ query: 'magic*', source: 'liked' })).toEqual(['Magic']);
    expect(titles({ query: 'magic*', source: 'catalog' })).toEqual([
      'Magical Mystery Tour',
    ]);
    expect(titles({ mode: 'year', query: '2000-2010', minPlays: 3 })).toEqual([
      'Under Your Spell',
    ]);
    expect(titles({ mode: 'year', query: '2000-2010', minPlays: 4 })).toEqual(
      [],
    );
  });

  test('tag and lyrics modes', () => {
    expect(titles({ mode: 'tag', query: 'dreamy' })).toEqual([
      'Under Your Spell',
    ]);
    const [row] = search(db, { ...defaults, mode: 'lyrics', query: 'magic' });
    expect(row?.match).toContain('[magic]');
  });

  test('rows carry sources, plays and tags', () => {
    const [row] = search(db, { ...defaults, mode: 'tag', query: 'dreamy' });
    expect(row).toMatchObject({
      artists: 'Desire',
      plays: 3,
      sources: [],
      tags: ['dreamy'],
      spotify_id: null,
    });
  });
});

test('ftsQuery quotes user input', () => {
  expect(ftsQuery('title', 'a "b" OR c*')).toBe(
    'title : ("a" AND """b""" AND "OR" AND "c"*)',
  );
});
