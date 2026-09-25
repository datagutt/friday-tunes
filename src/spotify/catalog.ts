import { Chunk, Effect, Stream } from 'effect';
import { Db } from '../db/db';
import { addSource, upsertArtist, upsertTrack } from '../db/library';
import { normalizeArtist } from '../normalize';
import { Spotify } from './client';
import { FollowedArtists, SimplifiedAlbum, Track } from './schema';
import { toTrackInput } from './sync';

// Catalogs change slowly; a month keeps new releases reasonably fresh
// without re-walking a thousand discographies every week.
const CATALOG_TTL_SECONDS = 30 * 24 * 3600;
// Spotify rejects larger pages on artist albums for dev-mode apps.
const ALBUM_PAGE = 10;

export const syncFollowed = Effect.gen(function* () {
  const spotify = yield* Spotify;
  const db = yield* Db;
  const artists: Array<{ id: string; name: string }> = [];
  let url: string | null = 'me/following?type=artist&limit=50';
  while (url) {
    const page: typeof FollowedArtists.Type = yield* spotify.get(
      FollowedArtists,
      url,
    );
    for (const a of page.artists.items) {
      if (a.id) artists.push({ id: a.id, name: a.name });
    }
    url = page.artists.next;
  }
  db.transaction(() => {
    db.run('update artists set followed = 0');
    const follow = db.query('update artists set followed = 1 where id = ?');
    for (const a of artists) {
      follow.run(upsertArtist(db, { name: a.name, spotifyId: a.id }));
    }
  })();
  yield* Effect.logInfo(`followed artists: ${artists.length}`);
});

const findSpotifyArtist = (name: string) =>
  Effect.flatMap(Spotify, (spotify) =>
    spotify.call('search', { query: { q: name, type: 'artist', limit: 5 } }),
  ).pipe(
    Effect.map((json) => {
      const items =
        (json as { artists?: { items?: Array<{ id: string; name: string }> } })
          .artists?.items ?? [];
      const wanted = normalizeArtist(name);
      return items.find((a) => normalizeArtist(a.name) === wanted)?.id;
    }),
  );

interface CatalogArtist {
  readonly id: number;
  readonly name: string;
  readonly spotify_id: string | null;
}

const syncArtistCatalog = (artist: CatalogArtist, spotifyId: string) =>
  Effect.gen(function* () {
    const spotify = yield* Spotify;
    const db = yield* Db;
    const albums = yield* spotify
      .paginate(SimplifiedAlbum, `artists/${spotifyId}/albums`, {
        include_groups: 'album,single',
        limit: ALBUM_PAGE,
      })
      .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray));

    for (const album of albums) {
      const tracks = yield* spotify
        .paginate(Track, `albums/${album.id}/tracks`, { limit: 50 })
        .pipe(Stream.runCollect);
      db.transaction(() => {
        for (const track of tracks) {
          // Split singles and various-artist releases carry tracks without
          // this artist; those belong to someone else's catalog.
          if (!track.artists.some((a) => a.id === spotifyId)) continue;
          const input = toTrackInput(track, {
            id: album.id,
            name: album.name,
            release_date: album.release_date,
          });
          if (input) {
            addSource(db, upsertTrack(db, input), 'catalog', spotifyId);
          }
        }
      })();
    }
    db.query(
      'update artists set catalog_synced_at = unixepoch() where id = ?',
    ).run(artist.id);
    return albums.length;
  });

// Followed artists plus the Last.fm all-time top artists. Last.fm favorites
// go first, so an interrupted first sync already covers the artists the
// user plays most.
export const syncCatalogs = Effect.gen(function* () {
  const db = yield* Db;
  const staleBefore = Math.floor(Date.now() / 1000) - CATALOG_TTL_SECONDS;
  const artists = db
    .query<CatalogArtist, [number]>(
      `select a.id, a.name, a.spotify_id from artists a
       where (a.followed = 1 or a.lastfm_rank is not null)
         and coalesce(a.catalog_synced_at, 0) < ?
       order by a.lastfm_rank is null, a.lastfm_rank,
         (select count(*) from track_artists ta where ta.artist_id = a.id) desc`,
    )
    .all(staleBefore);
  yield* Effect.logInfo(`catalogs: ${artists.length} artists to sync`);

  for (const [i, artist] of artists.entries()) {
    let spotifyId = artist.spotify_id;
    if (!spotifyId) {
      const found = yield* findSpotifyArtist(artist.name);
      const taken =
        found &&
        db
          .query<{ id: number }, [string]>(
            'select id from artists where spotify_id = ?',
          )
          .get(found);
      if (found && !taken) {
        db.query('update artists set spotify_id = ? where id = ?').run(
          found,
          artist.id,
        );
        spotifyId = found;
      }
    }
    if (!spotifyId) {
      db.query(
        'update artists set catalog_synced_at = unixepoch() where id = ?',
      ).run(artist.id);
      continue;
    }
    const albums = yield* syncArtistCatalog(artist, spotifyId);
    if ((i + 1) % 10 === 0 || i === artists.length - 1) {
      yield* Effect.logInfo(
        `catalogs: ${i + 1}/${artists.length} (${artist.name}: ${albums} releases)`,
      );
    }
  }
});
