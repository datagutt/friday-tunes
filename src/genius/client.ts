import { Effect, Redacted, Schema } from 'effect';
import { requestJson, retryTransient } from '../http';
import { normalizeArtist, normalizeTitle } from '../normalize';

const API = 'https://api.genius.com/';

const Search = Schema.Struct({
  response: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        result: Schema.Struct({
          id: Schema.Number,
          url: Schema.String,
          title: Schema.String,
          primary_artist: Schema.Struct({ name: Schema.String }),
        }),
      }),
    ),
  }),
});

export const geniusGet = <A, I>(
  schema: Schema.Schema<A, I>,
  path: string,
  params: Record<string, string | number>,
  token: Redacted.Redacted,
) => {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return retryTransient(
    requestJson('genius', url.toString(), {
      headers: { Authorization: `Bearer ${Redacted.value(token)}` },
    }),
  ).pipe(Effect.flatMap(Schema.decodeUnknown(schema)));
};

// Genius search is fuzzy and ranks popular songs first, so the hit must
// match the normalized title and primary artist exactly.
export const findSong = (
  title: string,
  artist: string,
  token: Redacted.Redacted,
) =>
  geniusGet(Search, 'search', { q: `${artist} ${title}` }, token).pipe(
    Effect.map((search) => {
      const wantedTitle = normalizeTitle(title);
      const wantedArtist = normalizeArtist(artist);
      return search.response.hits.find(
        (h) =>
          h.type === 'song' &&
          normalizeTitle(h.result.title) === wantedTitle &&
          normalizeArtist(h.result.primary_artist.name) === wantedArtist,
      )?.result;
    }),
  );
