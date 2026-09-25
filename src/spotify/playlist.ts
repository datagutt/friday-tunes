import { Effect, Schema } from 'effect';
import { Db } from '../db/db';
import { Spotify } from './client';
import { resolveTracks } from './resolve';
import { CreatedPlaylist } from './schema';

// Spotify accepts at most 100 URIs per add request.
const ADD_BATCH = 100;

export const createPlaylist = (options: {
  readonly name: string;
  readonly description?: string;
  readonly trackIds: ReadonlyArray<number>;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const spotify = yield* Spotify;
    const resolved = yield* resolveTracks(options.trackIds);

    const uris = [
      ...new Set(
        options.trackIds.flatMap((id) => {
          const spotifyId = resolved.get(id);
          return spotifyId ? [`spotify:track:${spotifyId}`] : [];
        }),
      ),
    ];
    const missing = options.trackIds
      .filter((id) => !resolved.get(id))
      .map(
        (id) =>
          db
            .query<{ title: string }, [number]>(
              'select title from tracks where id = ?',
            )
            .get(id)?.title ?? `#${id}`,
      );

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

    for (let i = 0; i < uris.length; i += ADD_BATCH) {
      yield* spotify.call(`playlists/${playlist.id}/items`, {
        method: 'POST',
        body: { uris: uris.slice(i, i + ADD_BATCH) },
      });
    }

    return { url: playlist.external_urls.spotify, added: uris.length, missing };
  });
