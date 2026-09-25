import type { Database } from 'bun:sqlite';
import { matchKey, normalizeArtist, normalizeTitle } from '../normalize';

export type Source = 'liked' | 'playlist' | 'top' | 'recent' | 'catalog';

export interface ArtistInput {
  readonly name: string;
  readonly spotifyId?: string | null;
}

export interface TrackInput {
  readonly title: string;
  readonly artists: ReadonlyArray<ArtistInput>;
  readonly spotifyId?: string | null;
  readonly isrc?: string | null;
  readonly album?: string | null;
  readonly albumSpotifyId?: string | null;
  readonly releaseYear?: number | null;
  readonly durationMs?: number | null;
}

export const upsertArtist = (db: Database, artist: ArtistInput): number => {
  const nameNorm = normalizeArtist(artist.name);
  if (artist.spotifyId) {
    const bySpotify = db
      .query<{ id: number }, [string]>(
        'select id from artists where spotify_id = ?',
      )
      .get(artist.spotifyId);
    if (bySpotify) return bySpotify.id;
  }
  // An artist first seen through Last.fm has no Spotify ID yet. Claim that
  // row instead of creating a twin when Spotify shows up with the same name.
  const byName = db
    .query<{ id: number; spotify_id: string | null }, [string]>(
      'select id, spotify_id from artists where name_norm = ? order by spotify_id is null desc limit 1',
    )
    .get(nameNorm);
  if (byName && (!artist.spotifyId || byName.spotify_id === null)) {
    if (artist.spotifyId) {
      db.query('update artists set spotify_id = ?, name = ? where id = ?').run(
        artist.spotifyId,
        artist.name,
        byName.id,
      );
    }
    return byName.id;
  }
  return Number(
    db
      .query(
        'insert into artists (spotify_id, name, name_norm) values (?, ?, ?)',
      )
      .run(artist.spotifyId ?? null, artist.name, nameNorm).lastInsertRowid,
  );
};

const findTrack = (db: Database, key: string, spotifyId?: string | null) => {
  if (spotifyId) {
    const byId = db
      .query<{ track_id: number }, [string]>(
        'select track_id from track_spotify_ids where spotify_id = ?',
      )
      .get(spotifyId);
    if (byId) return byId.track_id;
  }
  return db
    .query<{ id: number }, [string]>(
      'select id from tracks where match_key = ?',
    )
    .get(key)?.id;
};

export const upsertTrack = (db: Database, track: TrackInput): number => {
  const primary = track.artists[0];
  if (!primary) throw new Error(`Track "${track.title}" has no artists`);
  const key = matchKey(primary.name, track.title);
  const values = {
    key,
    spotify_id: track.spotifyId ?? null,
    isrc: track.isrc ?? null,
    title: track.title,
    title_norm: normalizeTitle(track.title),
    album: track.album ?? null,
    album_spotify_id: track.albumSpotifyId ?? null,
    release_year: track.releaseYear ?? null,
    duration_ms: track.durationMs ?? null,
  };

  let id = findTrack(db, key, track.spotifyId);
  if (id === undefined) {
    id = Number(
      db
        .query(
          `insert into tracks (match_key, spotify_id, isrc, title, title_norm,
             album, album_spotify_id, release_year, duration_ms)
           values ($key, $spotify_id, $isrc, $title, $title_norm, $album,
             $album_spotify_id, $release_year, $duration_ms)`,
        )
        .run(values).lastInsertRowid,
    );
  } else if (track.spotifyId) {
    // Spotify metadata wins over Last.fm metadata, but the first Spotify
    // version seen stays the preferred one.
    db.query(
      `update tracks set
         title = case when spotify_id is null then $title else title end,
         title_norm = case when spotify_id is null then $title_norm else title_norm end,
         album = case when spotify_id is null then $album else coalesce(album, $album) end,
         album_spotify_id = coalesce(album_spotify_id, $album_spotify_id),
         release_year = coalesce(release_year, $release_year),
         duration_ms = coalesce(duration_ms, $duration_ms),
         isrc = coalesce(isrc, $isrc),
         spotify_id = coalesce(spotify_id, $spotify_id),
         resolve_status = 'hit'
       where id = $id`,
    ).run({ ...values, id });
  } else {
    db.query(
      `update tracks set
         album = coalesce(album, $album),
         duration_ms = coalesce(duration_ms, $duration_ms)
       where id = $id`,
    ).run({ album: values.album, duration_ms: values.duration_ms, id });
  }

  if (track.spotifyId) {
    db.query(
      'insert or ignore into track_spotify_ids (spotify_id, track_id) values (?, ?)',
    ).run(track.spotifyId, id);
  }
  track.artists.forEach((artist, position) => {
    db.query(
      'insert or ignore into track_artists (track_id, artist_id, position) values (?, ?, ?)',
    ).run(id, upsertArtist(db, artist), position);
  });
  return id;
};

export const addSource = (
  db: Database,
  trackId: number,
  source: Source,
  ref = '',
  addedAt: number | null = null,
) => {
  db.query(
    `insert into track_sources (track_id, source, source_ref, added_at)
     values (?, ?, ?, ?)
     on conflict do update set added_at = coalesce(min(added_at, excluded.added_at), added_at, excluded.added_at)`,
  ).run(trackId, source, ref, addedAt);
};

export const clearSource = (db: Database, source: Source, ref?: string) => {
  if (ref === undefined) {
    db.query('delete from track_sources where source = ?').run(source);
  } else {
    db.query(
      'delete from track_sources where source = ? and source_ref = ?',
    ).run(source, ref);
  }
};

export const getState = (db: Database, key: string) =>
  db
    .query<{ value: string }, [string]>(
      'select value from sync_state where key = ?',
    )
    .get(key)?.value;

export const setState = (db: Database, key: string, value: string | number) => {
  db.query(
    'insert into sync_state (key, value) values (?, ?) on conflict do update set value = excluded.value',
  ).run(key, String(value));
};
