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
  readonly producer_artists: ReadonlyArray<GeniusArtist>;
  readonly writer_artists: ReadonlyArray<GeniusArtist>;
  readonly custom_performances: ReadonlyArray<{
    readonly label: string;
    readonly artists: ReadonlyArray<GeniusArtist>;
  }>;
}

// Background and additional vocals are left out: a woman humming behind a
// man's song does not make it a duet.
const VOCAL_ROLE = /^(?:lead |featured |rap )?vocals$/i;

const unique = (artists: ReadonlyArray<GeniusArtist>) => [
  ...new Map(artists.map((a) => [a.id, a])).values(),
];

// A "Vocals" credit names exactly who sings: Teardrop credits Elizabeth
// Fraser, not Massive Attack. Most songs have none, and then the main and
// featured artists stand in. Everyone else Genius credits (producers,
// writers, players, and Massive Attack on Teardrop) does not sing.
export const creditsOf = (credits: Credits) => {
  const vocals = credits.custom_performances
    .filter((p) => VOCAL_ROLE.test(p.label.trim()))
    .flatMap((p) => p.artists);
  const singers = unique(
    vocals.length
      ? vocals
      : [...credits.primary_artists, ...credits.featured_artists],
  );
  const singerIds = new Set(singers.map((s) => s.id));
  const others = unique([
    ...credits.primary_artists,
    ...credits.featured_artists,
    ...credits.producer_artists,
    ...credits.writer_artists,
    ...credits.custom_performances.flatMap((p) => p.artists),
  ]).filter((a) => !singerIds.has(a.id));
  return { singers, others };
};

// Genius spells some names its own way ("Bastian" for Spotify's
// "Bastian!"), so a credit first matches the song's own artists.
const ownArtist = (db: Database, trackId: number, name: string) =>
  db
    .query<{ id: number }, [number, string]>(
      `select a.id from track_artists ta join artists a on a.id = ta.artist_id
       where ta.track_id = ? and a.name_norm = ? limit 1`,
    )
    .get(trackId, normalizeArtist(name))?.id;

// A singer who is not one of the song's artists is matched to an artist
// seen on Genius before, then to any artist by name, or added.
const singerArtist = (db: Database, trackId: number, singer: GeniusArtist) => {
  const id =
    ownArtist(db, trackId, singer.name) ??
    db
      .query<{ id: number }, [number]>(
        'select id from artists where genius_id = ? limit 1',
      )
      .get(singer.id)?.id ??
    upsertArtist(db, { name: singer.name });
  db.query(
    'update artists set genius_id = ? where id = ? and genius_id is null',
  ).run(singer.id, id);
  return id;
};

// Non-singers matter only when Spotify lists them as the song's artists.
// Credits also name studios and labels, which are never added as artists.
export const saveCredits = (
  db: Database,
  trackId: number,
  credits: ReturnType<typeof creditsOf>,
) =>
  db
    .transaction(() => {
      db.query('delete from track_credits where track_id = ?').run(trackId);
      const insert = db.query(
        'insert or ignore into track_credits (track_id, artist_id, sings) values (?, ?, ?)',
      );
      for (const singer of credits.singers) {
        insert.run(trackId, singerArtist(db, trackId, singer), 1);
      }
      for (const other of credits.others) {
        const id = ownArtist(db, trackId, other.name);
        if (id !== undefined) insert.run(trackId, id, 0);
      }
      db.query(
        'update genius set credits_at = unixepoch() where track_id = ?',
      ).run(trackId);
    })
    .immediate();
