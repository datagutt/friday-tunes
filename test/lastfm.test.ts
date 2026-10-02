import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Db, DbMemory } from '../src/db/db';
import { getState, upsertArtist } from '../src/db/library';
import { cleanLastFmBio, syncLastFmBios } from '../src/lastfm/bios';
import { LastFm } from '../src/lastfm/client';
import { syncScrobbles } from '../src/lastfm/sync';
import { runWithClock, scriptFetch, testConfig } from './helpers';

const config = testConfig({ LASTFM_API_KEY: 'key', LASTFM_USER: 'datagutt' });
const layer = Layer.merge(DbMemory, LastFm.Default).pipe(Layer.provide(config));

const page = (
  track: unknown,
  { page = 1, totalPages = 1, total = 1 } = {},
) => ({
  recenttracks: {
    track,
    '@attr': {
      page: String(page),
      totalPages: String(totalPages),
      total: String(total),
    },
  },
});

const scrobble = (name: string, uts: number, artist = 'AURORA') => ({
  name,
  artist: { '#text': artist },
  album: { '#text': '' },
  date: { uts: String(uts) },
});

test('backfill skips nowplaying, accepts single objects and retries error 29', async () => {
  const http = scriptFetch([
    {
      url: 'method=user.getrecenttracks',
      json: page(
        [
          {
            name: 'Now Playing',
            artist: { '#text': 'AURORA' },
            '@attr': { nowplaying: 'true' },
          },
          scrobble('Conqueror', 300),
          scrobble('Running with the Wolves', 200),
        ],
        { totalPages: 2, total: 3 },
      ),
    },
    {
      url: 'page=2',
      status: 429,
      json: { error: 29, message: 'Rate Limit Exceeded' },
    },
    {
      url: 'page=2',
      json: page(scrobble('Conqueror', 100), { page: 2, totalPages: 2 }),
    },
    // The incremental pass after the backfill finds nothing new.
    { url: 'from=', json: page([], { totalPages: 0, total: 0 }) },
  ]);

  const result = await runWithClock(
    Effect.gen(function* () {
      yield* syncScrobbles;
      const db = yield* Db;
      return {
        plays: db
          .query(
            'select t.title, count(*) as plays from scrobbles s join tracks t on t.id = s.track_id group by t.id order by t.title',
          )
          .all(),
        backfillDone: getState(db, 'lastfm.backfill.done'),
        before: getState(db, 'lastfm.backfill.before'),
      };
    }).pipe(Effect.provide(layer)),
  );

  http.done();
  expect(http.seen[0]).toContain('api_key=key');
  expect(result).toEqual({
    plays: [
      { title: 'Conqueror', plays: 2 },
      { title: 'Running with the Wolves', plays: 1 },
    ],
    backfillDone: '1',
    before: '100',
  });
});

test('bio cleanup drops the Last.fm link, license line and markup', () => {
  expect(
    cleanLastFmBio(
      'Indie folk from <b>Åmli</b>.\n\n\n\nAcoustic  pop <a href="https://www.last.fm/music/X">Read more on Last.fm</a>. User-contributed text is available under the Creative Commons By-SA License.',
    ),
  ).toBe('Indie folk from Åmli.\nAcoustic pop');
  expect(
    cleanLastFmBio(' <a href="https://www.last.fm/music/X">Read more</a>'),
  ).toBeNull();
});

test('bios store the cleaned text and a miss for unknown artists', async () => {
  const http = scriptFetch([
    {
      url: 'artist=AURORA',
      json: { artist: { bio: { content: 'Norwegian singer.' } } },
    },
    {
      url: 'artist=Nobody',
      json: { error: 6, message: 'The artist you supplied could not be found' },
    },
  ]);
  const bios = await runWithClock(
    Effect.gen(function* () {
      const db = yield* Db;
      upsertArtist(db, { name: 'AURORA' });
      upsertArtist(db, { name: 'Nobody' });
      yield* syncLastFmBios;
      return db
        .query(
          `select a.name, b.bio from artist_bios b join artists a on a.id = b.artist_id
           where b.source = 'lastfm' order by a.id`,
        )
        .all();
    }).pipe(Effect.provide(layer)),
  );
  http.done();
  expect(bios).toEqual([
    { name: 'AURORA', bio: 'Norwegian singer.' },
    { name: 'Nobody', bio: null },
  ]);
});
