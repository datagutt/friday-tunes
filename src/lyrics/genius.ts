import { Effect, type Redacted } from 'effect';
import { findSong } from '../genius/client';
import { HttpError, request } from '../http';
import type { LyricsQuery, LyricsResult } from './lrclib';

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
    const song = yield* findSong(query.title, query.artist, token);
    if (!song) return { status: 'miss' } as LyricsResult;

    const html = yield* request('genius', song.url).pipe(
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
