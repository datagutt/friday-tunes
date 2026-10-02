import { Effect } from 'effect';
import { pendingBios, saveBio } from '../db/bios';
import { Db } from '../db/db';
import { LastFm } from './client';
import { ArtistInfo } from './schema';

// Last.fm appends a "Read more on Last.fm" link and a license line to
// every bio. Both are the same for every artist and would only add noise.
export const cleanLastFmBio = (content: string) => {
  const text = content
    .replace(/<a href="https:\/\/www\.last\.fm\/[\s\S]*$/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text || null;
};

export const syncLastFmBios = Effect.gen(function* () {
  const db = yield* Db;
  const lastfm = yield* LastFm;
  const artists = pendingBios(db, 'lastfm');
  yield* Effect.logInfo(`bios: ${artists.length} artists to fetch`);
  for (const [i, artist] of artists.entries()) {
    const bio = yield* lastfm
      .call(ArtistInfo, 'artist.getinfo', {
        artist: artist.name,
        autocorrect: 1,
      })
      .pipe(
        Effect.map((r) => cleanLastFmBio(r.artist.bio?.content ?? '')),
        Effect.catchTag('LastFmNotFound', () => Effect.succeed(null)),
      );
    saveBio(db, artist.id, 'lastfm', bio);
    if ((i + 1) % 500 === 0) {
      yield* Effect.logInfo(`bios: ${i + 1}/${artists.length} artists`);
    }
  }
});
