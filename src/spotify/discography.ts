import { Duration, Effect, Schema } from 'effect';
import { Db } from '../db/db';
import { addSource, getState, setState, upsertTrack } from '../db/library';
import { normalizeArtist } from '../normalize';
import { Spotify } from './client';
import { Paging, SimplifiedAlbum, Track } from './schema';
import { toTrackInput } from './sync';

// Spotify gave a 22 hour block after a few minutes of crawling at 5 calls
// per second. Discographies therefore trickle in: a small call budget per
// run, paced out, with an hourly launchd job doing the runs. A full first
// fill of ~900 artists takes about two weeks.
const CALLS_PER_RUN = 60;
const PACE = Duration.seconds(1);
// Re-list an artist's albums after this long to pick up new releases.
const RELIST_AFTER_SECONDS = 30 * 24 * 3600;
// Spotify rejects larger pages on artist albums for dev-mode apps.
const ALBUM_PAGE = 10;
const TRACK_PAGE = 50;

const ArtistSearch = Schema.Struct({
  artists: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String }),
    ),
  }),
});

interface PendingAlbum {
  readonly spotify_id: string;
  readonly name: string;
  readonly release_date: string | null;
  readonly artist_id: number;
  readonly artist_spotify_id: string;
}

interface ListingArtist {
  readonly id: number;
  readonly name: string;
  readonly spotify_id: string | null;
}

// Last.fm favorites first, then artists with the most library tracks.
const PRIORITY = `a.lastfm_rank is null, a.lastfm_rank,
  (select count(*) from track_artists ta where ta.artist_id = a.id) desc`;

export const syncDiscographies = Effect.gen(function* () {
  const db = yield* Db;
  const spotify = yield* Spotify;
  let calls = 0;
  const spend = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    calls++;
    return Effect.zipLeft(effect, Effect.sleep(PACE));
  };

  const nextAlbum = () =>
    db
      .query<PendingAlbum, []>(
        `select al.spotify_id, al.name, al.release_date, al.artist_id,
           a.spotify_id as artist_spotify_id
         from spotify_albums al join artists a on a.id = al.artist_id
         where al.tracks_synced_at is null and a.spotify_id is not null
         order by ${PRIORITY}, al.release_date desc limit 1`,
      )
      .get();

  const nextArtist = () =>
    db
      .query<ListingArtist, [number]>(
        `select a.id, a.name, a.spotify_id from artists a
         where (a.followed = 1 or a.lastfm_rank is not null)
           and coalesce(a.spotify_albums_at, 0) < ?
         order by ${PRIORITY} limit 1`,
      )
      .get(Math.floor(Date.now() / 1000) - RELIST_AFTER_SECONDS);

  const fetchAlbum = (album: PendingAlbum) =>
    Effect.gen(function* () {
      const tracks: Array<Track> = [];
      for (let offset = 0, more = true; more && calls < CALLS_PER_RUN; ) {
        const page = yield* spend(
          spotify.get(Paging(Track), `albums/${album.spotify_id}/tracks`, {
            limit: TRACK_PAGE,
            offset,
          }),
        );
        tracks.push(...page.items);
        offset += TRACK_PAGE;
        more = page.next !== null;
        if (more && calls >= CALLS_PER_RUN) return false;
      }
      db.transaction(() => {
        for (const track of tracks) {
          // Split singles and various-artist releases carry tracks without
          // this artist; those belong to someone else's discography.
          if (!track.artists.some((a) => a.id === album.artist_spotify_id)) {
            continue;
          }
          const input = toTrackInput(track, {
            id: album.spotify_id,
            name: album.name,
            release_date: album.release_date,
          });
          if (input) {
            addSource(
              db,
              upsertTrack(db, input),
              'discography',
              String(album.artist_id),
            );
          }
        }
        db.query(
          'update spotify_albums set tracks_synced_at = unixepoch() where spotify_id = ?',
        ).run(album.spotify_id);
      })();
      return true;
    });

  // Listing a big discography can outlast one run's budget, so the page
  // offset is saved and the next run continues from it.
  const listAlbums = (artist: ListingArtist) =>
    Effect.gen(function* () {
      let spotifyId = artist.spotify_id;
      if (!spotifyId) {
        const found = yield* spend(
          spotify.get(ArtistSearch, 'search', {
            q: artist.name,
            type: 'artist',
            limit: 5,
          }),
        );
        const wanted = normalizeArtist(artist.name);
        const match = found.artists.items.find(
          (a) => normalizeArtist(a.name) === wanted,
        );
        const taken =
          match &&
          db.query('select 1 from artists where spotify_id = ?').get(match.id);
        if (!match || taken) {
          db.query(
            'update artists set spotify_albums_at = unixepoch() where id = ?',
          ).run(artist.id);
          return;
        }
        db.query('update artists set spotify_id = ? where id = ?').run(
          match.id,
          artist.id,
        );
        spotifyId = match.id;
      }

      const offsetKey = `spotify.albums.offset.${artist.id}`;
      let offset = Number(getState(db, offsetKey) ?? 0);
      while (calls < CALLS_PER_RUN) {
        const page = yield* spend(
          spotify.get(Paging(SimplifiedAlbum), `artists/${spotifyId}/albums`, {
            include_groups: 'album,single',
            limit: ALBUM_PAGE,
            offset,
          }),
        );
        db.transaction(() => {
          const insert = db.query(
            'insert or ignore into spotify_albums (spotify_id, artist_id, name, release_date) values (?, ?, ?, ?)',
          );
          for (const album of page.items) {
            insert.run(
              album.id,
              artist.id,
              album.name,
              album.release_date ?? null,
            );
          }
          offset += ALBUM_PAGE;
          if (page.next === null) {
            db.query('delete from sync_state where key = ?').run(offsetKey);
            db.query(
              'update artists set spotify_albums_at = unixepoch() where id = ?',
            ).run(artist.id);
          } else {
            setState(db, offsetKey, offset);
          }
        })();
        if (page.next === null) return;
      }
    });

  let albums = 0;
  while (calls < CALLS_PER_RUN) {
    const album = nextAlbum();
    if (album) {
      if (yield* fetchAlbum(album)) albums++;
      continue;
    }
    const artist = nextArtist();
    if (!artist) break;
    yield* listAlbums(artist);
  }

  const left = db
    .query<{ n: number }, []>(
      'select count(*) as n from spotify_albums where tracks_synced_at is null',
    )
    .get()?.n;
  yield* Effect.logInfo(
    `discographies: ${albums} albums fetched with ${calls} calls, ${left} albums queued`,
  );
});
