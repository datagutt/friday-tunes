import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Db, DbMemory } from '../src/db/db';
import { addSource, upsertTrack } from '../src/db/library';
import { syncGenius } from '../src/genius/sync';
import { runWithClock, scriptFetch, testConfig } from './helpers';

const layer = DbMemory.pipe(
  Layer.provide(testConfig({ GENIUS_ACCESS_TOKEN: 'token' })),
);

const annotation = (plain: string, votes: number, extra = {}) => ({
  body: { plain },
  votes_total: votes,
  ...extra,
});

test('stores song notes and artist bios, and misses for unknown ones', async () => {
  const http = scriptFetch([
    {
      url: 'search?q=Radiohead+Burn+the+Witch',
      json: {
        response: {
          hits: [
            {
              type: 'song',
              result: {
                id: 7,
                url: 'https://genius.com/x',
                title: 'Burn the Witch',
                primary_artist: { name: 'Radiohead' },
              },
            },
          ],
        },
      },
    },
    {
      url: 'songs/7?text_format=plain',
      json: {
        response: { song: { description: { plain: 'About witch hunts.' } } },
      },
    },
    {
      url: 'referents?song_id=7',
      json: {
        response: {
          referents: [
            {
              fragment: 'About',
              is_description: true,
              annotations: [annotation('About witch hunts.', 99)],
            },
            {
              fragment: 'Burn the witch',
              annotations: [annotation('A mob chant.', 3)],
            },
            {
              fragment: 'Abandon all reason',
              annotations: [annotation('Groupthink.', 1, { verified: true })],
            },
          ],
        },
      },
    },
    { url: 'search?q=Nobody+Unknown', json: { response: { hits: [] } } },
    {
      url: 'search?q=Radiohead',
      json: {
        response: {
          hits: [
            {
              type: 'song',
              result: { primary_artist: { id: 9, name: 'Radiohead' } },
            },
          ],
        },
      },
    },
    {
      url: 'artists/9?text_format=plain',
      json: {
        response: { artist: { description: { plain: 'English rock band.' } } },
      },
    },
    // A hit by another artist with a similar name is not this artist.
    {
      url: 'search?q=Nobody',
      json: {
        response: {
          hits: [
            {
              type: 'song',
              result: { primary_artist: { id: 5, name: 'Nobody Else' } },
            },
          ],
        },
      },
    },
  ]);

  const rows = await runWithClock(
    Effect.gen(function* () {
      const db = yield* Db;
      for (const [title, artist] of [
        ['Burn the Witch', 'Radiohead'],
        ['Unknown', 'Nobody'],
      ] as const) {
        addSource(
          db,
          upsertTrack(db, { title, artists: [{ name: artist }] }),
          'liked',
        );
      }
      yield* syncGenius;
      return {
        songs: db
          .query(
            'select status, genius_id, about, annotations from genius order by track_id',
          )
          .all(),
        bios: db
          .query(
            `select a.name, b.bio from artist_bios b join artists a on a.id = b.artist_id
             where b.source = 'genius' order by a.id`,
          )
          .all(),
      };
    }).pipe(Effect.provide(layer)),
  );

  http.done();
  expect(rows.songs).toEqual([
    {
      status: 'hit',
      genius_id: 7,
      about: 'About witch hunts.',
      annotations:
        '"Abandon all reason": Groupthink.\n\n"Burn the witch": A mob chant.',
    },
    { status: 'miss', genius_id: null, about: null, annotations: null },
  ]);
  expect(rows.bios).toEqual([
    { name: 'Radiohead', bio: 'English rock band.' },
    { name: 'Nobody', bio: null },
  ]);
});
