import type { Database } from 'bun:sqlite';
import { upsertArtist } from '../db/library';
import { normalizeArtist } from '../normalize';

export interface GeniusArtist {
  readonly id: number;
  readonly name: string;
}

export interface Credits {
  readonly primary_artists: ReadonlyArray<GeniusArtist>;
  readonly featured_artists: ReadonlyArray<GeniusArtist>;
  readonly custom_performances: ReadonlyArray<{
    readonly label: string;
    readonly artists: ReadonlyArray<GeniusArtist>;
  }>;
}

// Background and additional vocals are left out: a woman humming behind a
// man's song does not make it a duet.
const VOCAL_ROLE = /^(?:lead |featured |rap )?vocals$/i;

// A "Vocals" credit names exactly who sings: Teardrop credits Elizabeth
// Fraser, not Massive Attack. Most songs have none, and then the main and
// featured artists stand in, which still leaves out the producers Spotify
// lists as artists.
export const singersOf = (credits: Credits) => {
  const vocals = credits.custom_performances
    .filter((p) => VOCAL_ROLE.test(p.label.trim()))
    .flatMap((p) => p.artists);
  const singers = vocals.length
    ? vocals
    : [...credits.primary_artists, ...credits.featured_artists];
  return [...new Map(singers.map((s) => [s.id, s])).values()];
};

// Genius spells some names its own way ("Bastian" for Spotify's
// "Bastian!"), so a singer first matches the song's own artists, then an
// artist seen on Genius before, then any artist by name.
const artistFor = (db: Database, trackId: number, singer: GeniusArtist) => {
  const nameNorm = normalizeArtist(singer.name);
  const own = db
    .query<{ id: number }, [number, string]>(
      `select a.id from track_artists ta join artists a on a.id = ta.artist_id
       where ta.track_id = ? and a.name_norm = ? limit 1`,
    )
    .get(trackId, nameNorm);
  const known = db
    .query<{ id: number }, [number]>(
      'select id from artists where genius_id = ? limit 1',
    )
    .get(singer.id);
  const id = own?.id ?? known?.id ?? upsertArtist(db, { name: singer.name });
  db.query(
    'update artists set genius_id = ? where id = ? and genius_id is null',
  ).run(singer.id, id);
  return id;
};

export const saveSingers = (
  db: Database,
  trackId: number,
  singers: ReadonlyArray<GeniusArtist>,
) =>
  db
    .transaction(() => {
      db.query('delete from track_singers where track_id = ?').run(trackId);
      for (const singer of singers) {
        db.query(
          'insert or ignore into track_singers (track_id, artist_id) values (?, ?)',
        ).run(trackId, artistFor(db, trackId, singer));
      }
      db.query(
        'update genius set credits_at = unixepoch() where track_id = ?',
      ).run(trackId);
    })
    .immediate();
