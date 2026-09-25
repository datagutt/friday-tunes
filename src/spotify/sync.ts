import { Effect, Either, Option, Schema, Stream } from 'effect';
import { Db } from '../db/db';
import {
  addSource,
  clearSource,
  getState,
  setState,
  type TrackInput,
  upsertArtist,
  upsertTrack,
} from '../db/library';
import { HttpError } from '../http';
import { Spotify } from './client';
import {
  ArtistRef,
  Me,
  Paging,
  Playlist,
  PlaylistEntry,
  RecentlyPlayed,
  releaseYear,
  SavedTrack,
  Track,
} from './schema';

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const toTrackInput = (
  track: Track,
  album = track.album,
): TrackInput | undefined =>
  track.artists.length === 0
    ? undefined
    : {
        title: track.name,
        spotifyId: track.id,
        isrc: track.external_ids?.isrc ?? null,
        album: album?.name ?? null,
        albumSpotifyId: album?.id ?? null,
        releaseYear: releaseYear(album?.release_date),
        durationMs: track.duration_ms,
        artists: track.artists.map((a) => ({ name: a.name, spotifyId: a.id })),
      };

const decodeTrack = Schema.decodeUnknownOption(Track);

// Liked Songs come newest first, so an incremental run stops at the first
// song older than the stored cursor. Only a full run notices unlikes.
export const syncLiked = (full: boolean) =>
  Effect.gen(function* () {
    const spotify = yield* Spotify;
    const db = yield* Db;
    const cursor = full ? 0 : Number(getState(db, 'spotify.liked.latest') ?? 0);
    const saved = yield* spotify
      .paginate(SavedTrack, 'me/tracks', { limit: 50 })
      .pipe(
        Stream.takeWhile((s) => epoch(s.added_at) > cursor),
        Stream.runCollect,
      );
    db.transaction(() => {
      if (full) clearSource(db, 'liked');
      let latest = cursor;
      for (const s of saved) {
        const input = toTrackInput(s.track);
        if (!input) continue;
        const addedAt = epoch(s.added_at);
        addSource(db, upsertTrack(db, input), 'liked', '', addedAt);
        latest = Math.max(latest, addedAt);
      }
      setState(db, 'spotify.liked.latest', latest);
    })();
    yield* Effect.logInfo(`liked songs: ${saved.length} new`);
  });

interface StoredPlaylist {
  snapshot_id: string | null;
  status: string;
}

const savePlaylist = (
  db: Db['Type'],
  playlist: typeof Playlist.Type,
  owned: boolean,
  status: 'ok' | 'forbidden' | 'not_owned',
) =>
  db
    .query(
      `insert into playlists (spotify_id, name, owned, snapshot_id, track_count, status, synced_at)
       values (?, ?, ?, ?, ?, ?, unixepoch())
       on conflict do update set name = excluded.name, owned = excluded.owned,
         snapshot_id = excluded.snapshot_id, track_count = excluded.track_count,
         status = excluded.status, synced_at = excluded.synced_at`,
    )
    .run(
      playlist.id,
      playlist.name,
      owned ? 1 : 0,
      playlist.snapshot_id ?? null,
      playlist.items?.total ?? playlist.tracks?.total ?? null,
      status,
    );

const PLAYLIST_PAGE = 10;

// Some playlists make Spotify return an empty `items` array for the whole
// page that contains them, with a normal `total` and no error. A short page
// is therefore re-read one playlist at a time, and the broken ones are
// skipped.
const listPlaylists = Effect.gen(function* () {
  const spotify = yield* Spotify;
  const page = Paging(Playlist);
  const playlists: Array<typeof Playlist.Type> = [];
  let skipped = 0;
  for (let offset = 0, total = 1; offset < total; offset += PLAYLIST_PAGE) {
    const result = yield* spotify.get(page, 'me/playlists', {
      limit: PLAYLIST_PAGE,
      offset,
    });
    total = result.total ?? 0;
    const expected = Math.min(PLAYLIST_PAGE, total - offset);
    if (result.items.length === expected) {
      playlists.push(...result.items);
      continue;
    }
    for (let i = offset; i < offset + expected; i++) {
      const single = yield* spotify.get(page, 'me/playlists', {
        limit: 1,
        offset: i,
      });
      if (single.items.length === 0) skipped++;
      playlists.push(...single.items);
    }
  }
  if (skipped > 0) {
    yield* Effect.logWarning(
      `playlists: Spotify returned nothing for ${skipped} playlist(s); they are skipped`,
    );
  }
  return playlists;
});

// Dev-mode apps only get the contents of playlists the user owns or
// collaborates on, so others are recorded as not_owned and never fetched.
export const syncPlaylists = (full: boolean) =>
  Effect.gen(function* () {
    const spotify = yield* Spotify;
    const db = yield* Db;
    const me = yield* spotify.get(Me, 'me');
    const playlists = yield* listPlaylists;

    let fetched = 0;
    for (const playlist of playlists) {
      const owned = playlist.owner.id === me.id;
      const stored = db
        .query<StoredPlaylist, [string]>(
          'select snapshot_id, status from playlists where spotify_id = ?',
        )
        .get(playlist.id);

      if (!(owned || playlist.collaborative)) {
        db.transaction(() => {
          clearSource(db, 'playlist', playlist.id);
          savePlaylist(db, playlist, owned, 'not_owned');
        })();
        continue;
      }
      if (
        !full &&
        stored?.status === 'ok' &&
        stored.snapshot_id === (playlist.snapshot_id ?? null)
      ) {
        continue;
      }

      const entries = yield* spotify
        .paginate(PlaylistEntry, `playlists/${playlist.id}/items`, {
          limit: 50,
          additional_types: 'track',
        })
        .pipe(Stream.runCollect, Effect.either);
      if (Either.isLeft(entries)) {
        const error = entries.left;
        if (error instanceof HttpError && [403, 404].includes(error.status)) {
          db.transaction(() => {
            clearSource(db, 'playlist', playlist.id);
            savePlaylist(db, playlist, owned, 'forbidden');
          })();
          continue;
        }
        return yield* Effect.fail(error);
      }

      db.transaction(() => {
        clearSource(db, 'playlist', playlist.id);
        for (const entry of entries.right) {
          const input = decodeTrack(entry.item ?? entry.track).pipe(
            Option.flatMap((t) => Option.fromNullable(toTrackInput(t))),
          );
          if (Option.isNone(input)) continue;
          addSource(
            db,
            upsertTrack(db, input.value),
            'playlist',
            playlist.id,
            entry.added_at ? epoch(entry.added_at) : null,
          );
        }
        savePlaylist(db, playlist, owned, 'ok');
      })();
      fetched++;
    }

    const seen = new Set(playlists.map((p) => p.id));
    const gone = db
      .query<{ spotify_id: string }, []>('select spotify_id from playlists')
      .all()
      .filter((p) => !seen.has(p.spotify_id));
    db.transaction(() => {
      for (const { spotify_id } of gone) {
        clearSource(db, 'playlist', spotify_id);
        db.query('delete from playlists where spotify_id = ?').run(spotify_id);
      }
    })();
    yield* Effect.logInfo(
      `playlists: ${playlists.length} listed, ${fetched} fetched, ${gone.length} removed`,
    );
  });

const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;

export const syncTop = Effect.gen(function* () {
  const spotify = yield* Spotify;
  const db = yield* Db;
  const takenAt = Math.floor(Date.now() / 1000);
  for (const range of TIME_RANGES) {
    const query = { time_range: range, limit: 50 };
    const tracks = yield* spotify.get(Paging(Track), 'me/top/tracks', query);
    const artists = yield* spotify.get(
      Paging(ArtistRef),
      'me/top/artists',
      query,
    );
    db.transaction(() => {
      clearSource(db, 'top', range);
      const snapshot = db.query(
        'insert or replace into top_snapshots (taken_at, kind, time_range, rank, spotify_id) values (?, ?, ?, ?, ?)',
      );
      tracks.items.forEach((track, rank) => {
        const input = toTrackInput(track);
        if (!(input && track.id)) return;
        addSource(db, upsertTrack(db, input), 'top', range);
        snapshot.run(takenAt, 'track', range, rank + 1, track.id);
      });
      artists.items.forEach((artist, rank) => {
        if (!artist.id) return;
        upsertArtist(db, { name: artist.name, spotifyId: artist.id });
        snapshot.run(takenAt, 'artist', range, rank + 1, artist.id);
      });
    })();
  }
  yield* Effect.logInfo('top tracks and artists: snapshot saved');
});

export const syncRecent = Effect.gen(function* () {
  const spotify = yield* Spotify;
  const db = yield* Db;
  const recent = yield* spotify.get(
    RecentlyPlayed,
    'me/player/recently-played',
    { limit: 50 },
  );
  db.transaction(() => {
    for (const play of recent.items) {
      const input = toTrackInput(play.track);
      if (!input) continue;
      addSource(
        db,
        upsertTrack(db, input),
        'recent',
        '',
        epoch(play.played_at),
      );
    }
  })();
  yield* Effect.logInfo(`recently played: ${recent.items.length} plays`);
});
