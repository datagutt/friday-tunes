import { Effect, Schema } from 'effect';
import { Db } from '../db/db';
import { addSource, clearSource, upsertTrack } from '../db/library';
import { LastFm } from './client';
import { List } from './schema';

// One Last.fm call per artist instead of ~25 Spotify calls for a full
// discography. Popular tracks cover what a theme usually picks; Spotify IDs
// are resolved later, only for the tracks that go into a playlist.
const TRACKS_PER_ARTIST = 100;
// Last.fm top tracks end in misspelled and duplicate scrobble titles with a
// handful of listeners. Relative to the artist's biggest track, so small
// artists keep their catalog too.
const MIN_LISTENER_SHARE = 0.01;
const CATALOG_TTL_SECONDS = 30 * 24 * 3600;

const TopTracks = Schema.Struct({
  toptracks: Schema.Struct({
    track: List(
      Schema.Struct({
        name: Schema.String,
        listeners: Schema.NumberFromString,
      }),
    ),
  }),
});

interface CatalogArtist {
  readonly id: number;
  readonly name: string;
  readonly spotify_id: string | null;
}

// Followed artists plus the Last.fm all-time top artists, favorites first.
export const syncCatalogs = Effect.gen(function* () {
  const db = yield* Db;
  const lastfm = yield* LastFm;
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
    const tracks = yield* lastfm
      .call(TopTracks, 'artist.gettoptracks', {
        artist: artist.name,
        limit: TRACKS_PER_ARTIST,
        autocorrect: 1,
      })
      .pipe(
        Effect.map((r) => r.toptracks.track),
        Effect.catchTag('LastFmNotFound', () => Effect.succeed([])),
      );
    const floor = (tracks[0]?.listeners ?? 0) * MIN_LISTENER_SHARE;
    const ref = String(artist.id);
    db.transaction(() => {
      clearSource(db, 'catalog', ref);
      for (const track of tracks) {
        if (track.listeners < floor) continue;
        const id = upsertTrack(db, {
          title: track.name,
          artists: [{ name: artist.name, spotifyId: artist.spotify_id }],
        });
        addSource(db, id, 'catalog', ref);
      }
      db.query(
        'update artists set catalog_synced_at = unixepoch() where id = ?',
      ).run(artist.id);
    })();
    if ((i + 1) % 100 === 0 || i === artists.length - 1) {
      yield* Effect.logInfo(`catalogs: ${i + 1}/${artists.length}`);
    }
  }
});
