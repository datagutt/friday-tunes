import { Effect, Redacted, Schema } from 'effect';
import { HttpError, request, requestJson, retryTransient } from '../http';
import { normalizeArtist, normalizeTitle } from '../normalize';
import type { LyricsQuery, LyricsResult } from './lrclib';

const Search = Schema.Struct({
  response: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        result: Schema.Struct({
          url: Schema.String,
          title: Schema.String,
          primary_artist: Schema.Struct({ name: Schema.String }),
        }),
      }),
    ),
  }),
});

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code.startsWith('#x'))
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#'))
      return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

// Genius has no lyrics API. Song pages keep the text in
// `data-lyrics-container` elements, with the header and ads excluded
// through `data-exclude-from-selection`.
export const extractLyrics = async (html: string) => {
  const parts: string[] = [];
  let excluded = 0;
  const container = '[data-lyrics-container="true"]';
  await new HTMLRewriter()
    .on(`${container} [data-exclude-from-selection]`, {
      element(el) {
        excluded++;
        el.onEndTag(() => {
          excluded--;
        });
      },
    })
    .on(`${container} br`, {
      element() {
        if (excluded === 0) parts.push('\n');
      },
    })
    .on(container, {
      element(el) {
        if (parts.length) parts.push('\n');
        el.onEndTag(() => {
          parts.push('\n');
        });
      },
      text(chunk) {
        if (excluded === 0) parts.push(chunk.text);
      },
    })
    .transform(new Response(html))
    .text();
  const text = decodeEntities(parts.join(''))
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
};

// Best effort: Genius often answers scripted page requests with a
// Cloudflare 403. Any failure counts as a miss so the sync keeps going.
export const geniusLyrics = (query: LyricsQuery, token: Redacted.Redacted) =>
  Effect.gen(function* () {
    const search = yield* retryTransient(
      requestJson(
        'genius',
        `https://api.genius.com/search?q=${encodeURIComponent(`${query.artist} ${query.title}`)}`,
        { headers: { Authorization: `Bearer ${Redacted.value(token)}` } },
      ),
    ).pipe(Effect.flatMap(Schema.decodeUnknown(Search)));
    const title = normalizeTitle(query.title);
    const artist = normalizeArtist(query.artist);
    const hit = search.response.hits.find(
      (h) =>
        h.type === 'song' &&
        normalizeTitle(h.result.title) === title &&
        normalizeArtist(h.result.primary_artist.name) === artist,
    );
    if (!hit) return { status: 'miss' } as LyricsResult;

    const html = yield* request('genius', hit.result.url).pipe(
      Effect.flatMap((res) => Effect.promise(() => res.text())),
    );
    const plain = yield* Effect.promise(() => extractLyrics(html));
    return (
      plain ? { status: 'hit', plain } : { status: 'miss' }
    ) as LyricsResult;
  }).pipe(
    Effect.catchAll((e) =>
      Effect.succeed<LyricsResult>({
        status: 'miss',
        blocked: e instanceof HttpError && e.status === 403,
      }),
    ),
  );
