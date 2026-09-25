import type { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import { openDatabase } from '../src/db/db';
import {
  addSource,
  clearSource,
  getState,
  setState,
  upsertTrack,
} from '../src/db/library';
import { migrations } from '../src/db/migrations';

const SQLITE_LIB = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';
let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:', SQLITE_LIB);
});

const count = (table: string) =>
  db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()?.n;

test('migrations create the vector and FTS tables', () => {
  const names = db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table'",
    )
    .all()
    .map((r) => r.name);
  expect(names).toContain('vec_tracks');
  expect(names).toContain('tracks_fts');
  expect(
    db.query<{ user_version: number }, []>('pragma user_version').get(),
  ).toEqual({ user_version: migrations.length });
});

test('a Last.fm track and its later Spotify version share one row', () => {
  const fromLastfm = upsertTrack(db, {
    title: 'Life On Mars? - 2015 Remaster',
    artists: [{ name: 'David Bowie' }],
  });
  const fromSpotify = upsertTrack(db, {
    title: 'Life On Mars?',
    artists: [{ name: 'David Bowie', spotifyId: 'bowie' }],
    spotifyId: 'sp1',
    album: 'Hunky Dory',
  });
  expect(fromSpotify).toBe(fromLastfm);
  expect(count('tracks')).toBe(1);
  expect(count('artists')).toBe(1);
  expect(db.query('select title, spotify_id, album from tracks').get()).toEqual(
    { title: 'Life On Mars?', spotify_id: 'sp1', album: 'Hunky Dory' },
  );
});

test('a second Spotify version maps to the row but keeps the first ID', () => {
  const a = upsertTrack(db, {
    title: 'Heroes',
    artists: [{ name: 'David Bowie', spotifyId: 'bowie' }],
    spotifyId: 'album-version',
  });
  const b = upsertTrack(db, {
    title: 'Heroes - 2017 Remaster',
    artists: [{ name: 'David Bowie', spotifyId: 'bowie' }],
    spotifyId: 'remaster',
  });
  expect(b).toBe(a);
  expect(db.query('select spotify_id from tracks').get()).toEqual({
    spotify_id: 'album-version',
  });
  expect(count('track_spotify_ids')).toBe(2);
});

test('covers by different artists stay separate', () => {
  upsertTrack(db, { title: 'Life On Mars', artists: [{ name: 'AURORA' }] });
  upsertTrack(db, {
    title: 'Life On Mars?',
    artists: [{ name: 'David Bowie' }],
  });
  expect(count('tracks')).toBe(2);
});

test('sources keep the earliest added_at and clear per ref', () => {
  const id = upsertTrack(db, { title: 'Magic', artists: [{ name: 'Pilot' }] });
  addSource(db, id, 'playlist', 'p1', 200);
  addSource(db, id, 'playlist', 'p1', 100);
  addSource(db, id, 'playlist', 'p2', 300);
  expect(
    db
      .query("select added_at from track_sources where source_ref = 'p1'")
      .get(),
  ).toEqual({ added_at: 100 });
  clearSource(db, 'playlist', 'p1');
  expect(count('track_sources')).toBe(1);
});

test('sync state round-trips', () => {
  expect(getState(db, 'cursor')).toBeUndefined();
  setState(db, 'cursor', 42);
  setState(db, 'cursor', 43);
  expect(getState(db, 'cursor')).toBe('43');
});
