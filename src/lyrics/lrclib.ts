import { Effect, Schema } from 'effect';
import { HttpError, requestJson, retryTransient } from '../http';
import { normalizeArtist, normalizeTitle } from '../normalize';

const API = 'https://lrclib.net/api/';

const Record = Schema.Struct({
  trackName: Schema.String,
  artistName: Schema.String,
  instrumental: Schema.Boolean,
  plainLyrics: Schema.NullOr(Schema.String),
});
type Record = typeof Record.Type;

export interface LyricsQuery {
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly durationMs: number | null;
}

export type LyricsResult =
  | { readonly status: 'hit'; readonly plain: string }
  | { readonly status: 'instrumental' }
  | { readonly status: 'miss'; readonly blocked?: boolean };

const fromRecord = (record: Record): LyricsResult =>
  record.instrumental
    ? { status: 'instrumental' }
    : record.plainLyrics
      ? { status: 'hit', plain: record.plainLyrics }
      : { status: 'miss' };

const url = (path: string, params: { [key: string]: string | undefined }) => {
  const u = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    if (value) u.searchParams.set(key, value);
  }
  return u.toString();
};

const notFound = (e: unknown) => e instanceof HttpError && e.status === 404;

// `get` only matches when the duration is within 2 seconds, so it is tried
// first for precision. `search` is looser and needs our own title check.
export const lrclibLyrics = (query: LyricsQuery) =>
  Effect.gen(function* () {
    if (query.durationMs) {
      const exact = yield* retryTransient(
        requestJson(
          'lrclib',
          url('get', {
            track_name: query.title,
            artist_name: query.artist,
            album_name: query.album ?? undefined,
            duration: String(Math.round(query.durationMs / 1000)),
          }),
        ),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknown(Record)),
        Effect.map(fromRecord),
        Effect.catchIf(notFound, () =>
          Effect.succeed<LyricsResult>({ status: 'miss' }),
        ),
      );
      if (exact.status !== 'miss') return exact;
    }

    const results = yield* retryTransient(
      requestJson(
        'lrclib',
        url('search', { track_name: query.title, artist_name: query.artist }),
      ),
    ).pipe(Effect.flatMap(Schema.decodeUnknown(Schema.Array(Record))));
    const title = normalizeTitle(query.title);
    const artist = normalizeArtist(query.artist);
    const match = results.find(
      (r) =>
        normalizeTitle(r.trackName) === title &&
        normalizeArtist(r.artistName) === artist &&
        (r.instrumental || r.plainLyrics),
    );
    return match ? fromRecord(match) : ({ status: 'miss' } as const);
  });
