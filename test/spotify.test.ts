import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { Db, DbMemory } from '../src/db/db';
import { Spotify } from '../src/spotify/client';
import { syncDiscographies } from '../src/spotify/discography';
import { syncPlaylists } from '../src/spotify/sync';
import { runWithClock, scriptFetch, testConfig } from './helpers';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-tunes-'));
fs.writeFileSync(
  path.join(dataDir, 'spotify-token.json'),
  JSON.stringify({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 4_102_444_800_000,
  }),
);

const config = testConfig({
  FRIDAY_TUNES_DATA_DIR: dataDir,
  SPOTIFY_CLIENT_ID: 'id',
  SPOTIFY_CLIENT_SECRET: 'secret',
});
const layer = Spotify.Default.pipe(
  Layer.provideMerge(DbMemory),
  Layer.provide(config),
);

const playlist = (id: string, owner = 'me') => ({
  id,
  name: `List ${id}`,
  collaborative: false,
  snapshot_id: `snap-${id}`,
  owner: { id: owner },
  items: { total: 1 },
});

const track = (id: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  item: {
    id,
    name: `Song ${id}`,
    duration_ms: 1000,
    artists: [{ id: 'a', name: 'Artist' }],
  },
});

test('re-reads short playlist pages one by one and waits out 429', async () => {
  const http = scriptFetch([
    { url: 'v1/me', json: { id: 'me' } },
    // Spotify blanks the whole page because of the broken playlist at 1.
    {
      url: 'me/playlists?limit=10&offset=0',
      json: { items: [], next: null, total: 3 },
    },
    {
      url: 'limit=1&offset=0',
      json: { items: [playlist('p0')], next: null, total: 3 },
    },
    {
      url: 'limit=1&offset=1',
      status: 429,
      headers: { 'Retry-After': '3' },
    },
    { url: 'limit=1&offset=1', json: { items: [], next: null, total: 3 } },
    {
      url: 'limit=1&offset=2',
      json: { items: [playlist('p2', 'someone-else')], next: null, total: 3 },
    },
    {
      url: 'playlists/p0/items',
      json: { items: [track('t1')], next: null },
    },
  ]);

  const rows = await runWithClock(
    Effect.gen(function* () {
      yield* syncPlaylists(false);
      const db = yield* Db;
      return db
        .query(
          'select p.spotify_id, p.status, count(s.track_id) as tracks from playlists p left join track_sources s on s.source_ref = p.spotify_id group by p.spotify_id',
        )
        .all();
    }).pipe(Effect.provide(layer)),
  );

  http.done();
  expect(rows).toEqual([
    { spotify_id: 'p0', status: 'ok', tracks: 1 },
    { spotify_id: 'p2', status: 'not_owned', tracks: 0 },
  ]);
});

test('discography lists albums, then fetches their tracks, keeping progress', async () => {
  const albumTrack = (id: string, artistId: string) => ({
    id,
    name: `Song ${id}`,
    duration_ms: 1000,
    artists: [
      { id: artistId, name: artistId === 'aurora' ? 'AURORA' : 'Other' },
    ],
  });
  const http = scriptFetch([
    {
      url: 'artists/aurora/albums?include_groups=album%2Csingle&limit=10&offset=0',
      json: {
        items: [
          { id: 'al1', name: 'Album', release_date: '2016-03-11' },
          { id: 'al2', name: 'Split Single', release_date: '2020-01-01' },
        ],
        next: null,
      },
    },
    {
      url: 'albums/al2/tracks',
      json: {
        items: [albumTrack('s1', 'aurora'), albumTrack('s2', 'other')],
        next: null,
      },
    },
    {
      url: 'albums/al1/tracks',
      json: { items: [albumTrack('a1', 'aurora')], next: null },
    },
  ]);

  const result = await runWithClock(
    Effect.gen(function* () {
      const db = yield* Db;
      db.query(
        "insert into artists (spotify_id, name, name_norm, followed) values ('aurora', 'AURORA', 'aurora', 1)",
      ).run();
      yield* syncDiscographies;
      return {
        tracks: db
          .query(
            "select t.title, t.album, t.release_year from track_sources s join tracks t on t.id = s.track_id where s.source = 'discography' order by t.title",
          )
          .all(),
        pending: db
          .query(
            'select count(*) as n from spotify_albums where tracks_synced_at is null',
          )
          .get(),
        listed: db
          .query(
            "select spotify_albums_at is not null as done from artists where spotify_id = 'aurora'",
          )
          .get(),
      };
    }).pipe(Effect.provide(layer)),
  );

  http.done();
  expect(result).toEqual({
    tracks: [
      { title: 'Song a1', album: 'Album', release_year: 2016 },
      { title: 'Song s1', album: 'Split Single', release_year: 2020 },
    ],
    pending: { n: 0 },
    listed: { done: 1 },
  });
});
