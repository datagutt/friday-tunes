import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { Db, DbMemory } from '../src/db/db';
import { Spotify } from '../src/spotify/client';
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
const layer = Layer.merge(DbMemory, Spotify.Default).pipe(
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
