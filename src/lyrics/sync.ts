import { Effect, Option, RateLimiter } from 'effect';
import { geniusToken } from '../config';
import { Db } from '../db/db';
import { ENRICH_TRACKS } from '../lastfm/sync';
import { geniusLyrics } from './genius';
import { type LyricsQuery, type LyricsResult, lrclibLyrics } from './lrclib';

// A miss is retried after this long, since both sources keep growing.
const MISS_RETRY_SECONDS = 90 * 24 * 3600;
// LRCLIB publishes no limit; this pace keeps it polite.
const CALLS_PER_SECOND = 4;

interface Pending {
  readonly id: number;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly duration_ms: number | null;
}

export const syncLyrics = Effect.gen(function* () {
  const db = yield* Db;
  const token = yield* geniusToken;
  const limiter = yield* RateLimiter.make({
    limit: CALLS_PER_SECOND,
    interval: '1 second',
  });
  const retryBefore = Math.floor(Date.now() / 1000) - MISS_RETRY_SECONDS;
  const pending = db
    .query<Pending, [number, number]>(
      `select t.id, t.title, t.album, t.duration_ms,
         (select a.name from track_artists ta join artists a on a.id = ta.artist_id
          where ta.track_id = t.id order by ta.position limit 1) as artist
       from tracks t left join lyrics l on l.track_id = t.id
       where (l.track_id is null
         or (l.status = 'miss' and (l.fetched_at < ?
           -- A miss that only tried LRCLIB gets one Genius try once a token exists.
           or (? and coalesce(l.source, 'lrclib') = 'lrclib'))))
         and (${ENRICH_TRACKS})`,
    )
    .all(retryBefore, Option.isSome(token) ? 1 : 0);
  yield* Effect.logInfo(
    `lyrics: ${pending.length} tracks to fetch${Option.isNone(token) ? ' (no Genius token, LRCLIB only)' : ''}`,
  );

  const save = db.query(
    `insert into lyrics (track_id, status, source, plain, instrumental, fetched_at)
     values (?, ?, ?, ?, ?, unixepoch())
     on conflict do update set status = excluded.status, source = excluded.source,
       plain = excluded.plain, instrumental = excluded.instrumental,
       fetched_at = excluded.fetched_at`,
  );
  let hits = 0;
  let blocked = 0;
  for (const [i, track] of pending.entries()) {
    const query: LyricsQuery = {
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.duration_ms,
    };
    let source = 'lrclib';
    let result: LyricsResult = yield* limiter(lrclibLyrics(query)).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(
          `lyrics: LRCLIB failed for ${track.title}: ${e.message}`,
        ).pipe(Effect.as<LyricsResult>({ status: 'miss' })),
      ),
    );
    if (result.status === 'miss' && Option.isSome(token)) {
      source = 'genius';
      result = yield* limiter(geniusLyrics(query, token.value));
    }
    save.run(
      track.id,
      result.status,
      // For a miss, source records the last source tried.
      source,
      result.status === 'hit' ? result.plain : null,
      result.status === 'instrumental' ? 1 : 0,
    );
    if (result.status !== 'miss') hits++;
    else if (result.blocked) blocked++;
    if ((i + 1) % 250 === 0 || i === pending.length - 1) {
      yield* Effect.logInfo(
        `lyrics: ${i + 1}/${pending.length} (${hits} found, ${blocked} blocked by Genius)`,
      );
    }
  }
});
