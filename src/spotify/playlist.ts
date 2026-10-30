import type { Database } from 'bun:sqlite';
import { Effect, Schema } from 'effect';
import { Db } from '../db/db';
import { songKey } from '../normalize';
import { Spotify } from './client';
import { resolveTracks } from './resolve';
import { CreatedPlaylist } from './schema';

// Spotify accepts at most 100 URIs per add or remove request.
const BATCH = 100;

export interface Missing {
  readonly id: number;
  readonly title: string;
  readonly artists: string;
  /**
   * Other indexed versions of the same song that may be on Spotify: those
   * with a Spotify ID, and those not looked up yet.
   */
  readonly alternatives: ReadonlyArray<{ id: number; artists: string }>;
}

const describeTrack = (db: Database, id: number) =>
  db
    .query<{ title: string; artists: string | null }, [number]>(
      `select t.title, (select group_concat(name, ', ') from (
         select a.name from track_artists ta join artists a on a.id = ta.artist_id
         where ta.track_id = t.id order by ta.position)) as artists
       from tracks t where t.id = ?`,
    )
    .get(id);

// A song missing on Spotify in one version is often there as a cover or
// another recording, which the index may already hold.
const alternatives = (db: Database, id: number, title: string) => {
  const key = songKey(title);
  const word = key.split(' ').sort((a, b) => b.length - a.length)[0];
  if (!word) return [];
  return db
    .query<
      { id: number; title: string; artists: string | null },
      [string, number]
    >(
      `select t.id, t.title, (select group_concat(name, ', ') from (
         select a.name from track_artists ta join artists a on a.id = ta.artist_id
         where ta.track_id = t.id order by ta.position)) as artists
       from tracks t
       where coalesce(t.resolve_status, '') != 'miss' and t.title_norm like ? and t.id != ?
       order by (select count(*) from scrobbles sc where sc.track_id = t.id) desc`,
    )
    .all(`%${word}%`, id)
    .filter((t) => songKey(t.title) === key)
    .slice(0, 3)
    .map((t) => ({ id: t.id, artists: t.artists ?? '' }));
};

const toUris = (trackIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const resolved = yield* resolveTracks(trackIds);
    const uris = [
      ...new Set(
        trackIds.flatMap((id) => {
          const spotifyId = resolved.get(id);
          return spotifyId ? [`spotify:track:${spotifyId}`] : [];
        }),
      ),
    ];
    const missing = trackIds
      .filter((id) => !resolved.get(id))
      .map((id): Missing => {
        const track = describeTrack(db, id);
        return {
          id,
          title: track?.title ?? `#${id}`,
          artists: track?.artists ?? '',
          alternatives: track ? alternatives(db, id, track.title) : [],
        };
      });
    return { uris, missing };
  });

// Accepts a playlist link, a spotify:playlist: URI or a bare ID.
export const playlistId = (ref: string) =>
  ref.match(/playlist[/:]([A-Za-z0-9]+)/)?.[1] ?? ref;

const sendItems = (
  playlist: string,
  method: 'POST' | 'DELETE',
  uris: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const spotify = yield* Spotify;
    for (let i = 0; i < uris.length; i += BATCH) {
      const batch = uris.slice(i, i + BATCH);
      yield* spotify.call(`playlists/${playlist}/items`, {
        method,
        body:
          method === 'POST'
            ? { uris: batch }
            : { items: batch.map((uri) => ({ uri })) },
      });
    }
  });

export const createPlaylist = (options: {
  readonly name: string;
  readonly description?: string;
  readonly trackIds: ReadonlyArray<number>;
}) =>
  Effect.gen(function* () {
    const spotify = yield* Spotify;
    const { uris, missing } = yield* toUris(options.trackIds);
    const playlist = yield* spotify
      .call('me/playlists', {
        method: 'POST',
        body: {
          name: options.name,
          description: options.description ?? '',
          public: false,
        },
      })
      .pipe(Effect.flatMap(Schema.decodeUnknown(CreatedPlaylist)));
    yield* sendItems(playlist.id, 'POST', uris);
    return { url: playlist.external_urls.spotify, count: uris.length, missing };
  });

export const changePlaylist = (options: {
  readonly playlist: string;
  readonly action: 'add' | 'remove';
  readonly trackIds: ReadonlyArray<number>;
}) =>
  Effect.gen(function* () {
    const id = playlistId(options.playlist);
    const { uris, missing } = yield* toUris(options.trackIds);
    yield* sendItems(id, options.action === 'add' ? 'POST' : 'DELETE', uris);
    return {
      url: `https://open.spotify.com/playlist/${id}`,
      count: uris.length,
      missing,
    };
  });
