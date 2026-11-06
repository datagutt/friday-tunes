import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Db, DbMemory, openDatabase } from '../src/db/db';
import { upsertTrack } from '../src/db/library';
import { saveSingers, singersOf } from '../src/genius/singers';
import { search } from '../src/search/search';
import { setManualVoice } from '../src/voices/manual';
import { syncMusicBrainzVoices } from '../src/voices/musicbrainz';
import { rebuildVoices, saveVoice } from '../src/voices/voices';
import { syncWikidataVoices } from '../src/voices/wikidata';
import { runWithClock, SQLITE_LIB, scriptFetch, testConfig } from './helpers';

const layer = DbMemory.pipe(Layer.provide(testConfig({})));

const artistId = (db: Database, name: string) =>
  db
    .query<{ id: number }, [string]>('select id from artists where name = ?')
    .get(name)?.id ?? -1;

const vocals = (db: Database, title: string) =>
  db
    .query<{ vocals: string | null }, [string]>(
      'select vocals from tracks where title = ?',
    )
    .get(title)?.vocals;

describe('singersOf', () => {
  const credits = {
    primary_artists: [{ id: 1, name: 'Massive Attack' }],
    featured_artists: [{ id: 2, name: 'Elizabeth Fraser' }],
    custom_performances: [] as Array<{
      label: string;
      artists: Array<{ id: number; name: string }>;
    }>,
  };

  test('a vocals credit names exactly who sings', () => {
    const singers = singersOf({
      ...credits,
      custom_performances: [
        { label: 'Vocals', artists: [{ id: 2, name: 'Elizabeth Fraser' }] },
        { label: 'Background Vocals', artists: [{ id: 3, name: 'Choir' }] },
        { label: 'Keyboards', artists: [{ id: 1, name: 'Massive Attack' }] },
      ],
    });
    expect(singers.map((s) => s.name)).toEqual(['Elizabeth Fraser']);
  });

  test('without one, main and featured artists stand in', () => {
    expect(singersOf(credits).map((s) => s.name)).toEqual([
      'Massive Attack',
      'Elizabeth Fraser',
    ]);
  });
});

describe('rebuildVoices', () => {
  test('derives artist voices by source and track vocals from singers', () => {
    const db = openDatabase(':memory:', SQLITE_LIB);
    const duet = upsertTrack(db, {
      title: 'Jeg har blitt en hoe',
      artists: [{ name: 'Synne Sørgjerd' }, { name: 'Bastian!' }],
      releaseYear: 2023,
    });
    upsertTrack(db, {
      title: '04800',
      artists: [{ name: 'Nick Strand' }, { name: 'Mio' }],
      releaseYear: 2020,
    });
    const produced = upsertTrack(db, {
      title: 'Teardrop',
      artists: [{ name: 'Massive Attack' }, { name: 'Elizabeth Fraser' }],
      releaseYear: 1998,
    });
    const synne = artistId(db, 'Synne Sørgjerd');
    saveVoice(db, synne, 'wikidata', 'female');
    // Last.fm tags count only when no other source knows.
    db.query(
      "insert into tags (entity, entity_id, tag, weight) values ('artist', ?, 'male vocalists', 50)",
    ).run(synne);
    saveVoice(db, artistId(db, 'Nick Strand'), 'musicbrainz', 'male');
    saveVoice(db, artistId(db, 'Mio'), 'wikidata', 'female');
    saveVoice(db, artistId(db, 'Massive Attack'), 'wikidata', 'male');
    saveVoice(db, artistId(db, 'Elizabeth Fraser'), 'wikidata', 'female');
    db.query(
      "insert into genius (track_id, status, genius_id, fetched_at) values (?, 'hit', 1, 0), (?, 'hit', 2, 0)",
    ).run(duet, produced);
    // Genius writes "Bastian" where Spotify writes "Bastian!".
    saveSingers(db, duet, [
      { id: 10, name: 'Synne Sørgjerd' },
      { id: 11, name: 'Bastian' },
    ]);
    saveSingers(db, produced, [{ id: 12, name: 'Elizabeth Fraser' }]);
    rebuildVoices(db);

    expect(vocals(db, 'Teardrop')).toBe('female');
    // Without Genius credits the Spotify artists count, producer included.
    expect(vocals(db, '04800')).toBe('mixed');
    // Bastian! has no voice yet, so the duet is only known as female.
    expect(vocals(db, 'Jeg har blitt en hoe')).toBe('female');
    expect(artistId(db, 'Bastian')).toBe(-1);

    setManualVoice(db, 'bastian!', 'male');
    expect(vocals(db, 'Jeg har blitt en hoe')).toBe('mixed');
    const byVocals = (vocals: 'mixed' | 'female') =>
      search(db, {
        mode: 'year',
        query: '1990-2030',
        limit: 10,
        source: 'any',
        minPlays: 0,
        substring: false,
        vocals,
      }).map((r) => `${r.title}: ${r.vocals}`);
    expect(byVocals('mixed').sort()).toEqual([
      '04800: mixed',
      'Jeg har blitt en hoe: mixed',
    ]);
    expect(byVocals('female')).toEqual(['Teardrop: female']);
  });
});

describe('voice sync', () => {
  test('Wikidata gives people their gender and bands their singers', async () => {
    const http = scriptFetch([
      {
        url: 'srsearch=haswbstatement%3AP1902%3Dromy%7CP1902%3Dxx%7CP1902%3Dnobody',
        json: { query: { search: [{ title: 'Q1' }, { title: 'Q2' }] } },
      },
      {
        url: 'ids=Q1%7CQ2',
        json: {
          entities: {
            Q1: {
              claims: {
                P1902: [{ mainsnak: { datavalue: { value: 'romy' } } }],
                P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }],
                P21: [
                  { mainsnak: { datavalue: { value: { id: 'Q6581072' } } } },
                ],
              },
            },
            Q2: {
              claims: {
                P1902: [{ mainsnak: { datavalue: { value: 'xx' } } }],
                P31: [
                  { mainsnak: { datavalue: { value: { id: 'Q215380' } } } },
                ],
                P527: ['Q1', 'Q3', 'Q4'].map((id) => ({
                  mainsnak: { datavalue: { value: { id } } },
                })),
              },
            },
          },
        },
      },
      {
        url: 'ids=Q1%7CQ3%7CQ4',
        json: {
          entities: {
            Q1: {
              claims: {
                P21: [
                  { mainsnak: { datavalue: { value: { id: 'Q6581072' } } } },
                ],
                P106: [
                  { mainsnak: { datavalue: { value: { id: 'Q177220' } } } },
                ],
              },
            },
            Q3: {
              claims: {
                P21: [
                  { mainsnak: { datavalue: { value: { id: 'Q6581097' } } } },
                ],
                P106: [
                  { mainsnak: { datavalue: { value: { id: 'Q177220' } } } },
                ],
              },
            },
            // A man who only plays keyboards does not count.
            Q4: {
              claims: {
                P21: [
                  { mainsnak: { datavalue: { value: { id: 'Q6581097' } } } },
                ],
              },
            },
          },
        },
      },
    ]);
    const voices = await runWithClock(
      Effect.gen(function* () {
        const db = yield* Db;
        upsertTrack(db, {
          title: 'Islands',
          artists: [
            { name: 'Romy', spotifyId: 'romy' },
            { name: 'The xx', spotifyId: 'xx' },
            { name: 'Nobody', spotifyId: 'nobody' },
          ],
        });
        yield* syncWikidataVoices;
        return db
          .query(
            `select a.name, v.voice from artist_voices v join artists a on a.id = v.artist_id
             where v.source = 'wikidata' order by a.name`,
          )
          .all();
      }).pipe(Effect.provide(layer)),
    );
    http.done();
    expect(voices).toEqual([
      { name: 'Nobody', voice: null },
      { name: 'Romy', voice: 'female' },
      { name: 'The xx', voice: 'mixed' },
    ]);
  });

  test('MusicBrainz looks up artists by their Spotify link', async () => {
    const http = scriptFetch([
      {
        url: 'url?resource=https%3A%2F%2Fopen.spotify.com%2Fartist%2Fkaja',
        json: {
          relations: [{ 'target-type': 'artist', artist: { id: 'mb-kaja' } }],
        },
      },
      {
        url: 'artist/mb-kaja?inc=artist-rels',
        json: { type: 'Person', gender: 'Female', relations: [] },
      },
      {
        url: 'url?resource=https%3A%2F%2Fopen.spotify.com%2Fartist%2Fvetle',
        status: 404,
        json: { error: 'Not Found' },
      },
    ]);
    const voices = await runWithClock(
      Effect.gen(function* () {
        const db = yield* Db;
        upsertTrack(db, {
          title: 'Song',
          artists: [
            { name: 'Kaja Gunnufsen', spotifyId: 'kaja' },
            { name: 'Vetle', spotifyId: 'vetle' },
            { name: 'Known', spotifyId: 'known' },
          ],
        });
        // Wikidata already placed this one, so MusicBrainz skips it.
        saveVoice(db, artistId(db, 'Known'), 'wikidata', 'male');
        yield* syncMusicBrainzVoices;
        return db
          .query(
            `select a.name, v.voice from artist_voices v join artists a on a.id = v.artist_id
             where v.source = 'musicbrainz' order by a.name`,
          )
          .all();
      }).pipe(Effect.provide(layer)),
    );
    http.done();
    expect(voices).toEqual([
      { name: 'Kaja Gunnufsen', voice: 'female' },
      { name: 'Vetle', voice: null },
    ]);
  });
});
