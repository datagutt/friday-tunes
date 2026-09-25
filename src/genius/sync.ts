import { Duration, Effect, Option, Schema } from 'effect';
import { geniusToken } from '../config';
import { Db } from '../db/db';
import { ENRICH_TRACKS } from '../lastfm/sync';
import { findSong, geniusGet } from './client';

// Genius publishes no rate limit. After Spotify handed out a 22 hour block,
// this runs as a slow trickle from the hourly launchd job: about 300 songs
// per run, so the ~9k library tracks fill in over a day or two.
const CALLS_PER_RUN = 900;
const PACE = Duration.seconds(1);
// A song not on Genius today may be added later.
const MISS_RETRY_SECONDS = 180 * 24 * 3600;
const MAX_ANNOTATIONS = 20;

const Song = Schema.Struct({
  response: Schema.Struct({
    song: Schema.Struct({
      description: Schema.optional(
        Schema.NullOr(Schema.Struct({ plain: Schema.String })),
      ),
    }),
  }),
});

const Referents = Schema.Struct({
  response: Schema.Struct({
    referents: Schema.Array(
      Schema.Struct({
        fragment: Schema.String,
        is_description: Schema.optionalWith(Schema.Boolean, {
          default: () => false,
        }),
        annotations: Schema.Array(
          Schema.Struct({
            body: Schema.Struct({ plain: Schema.String }),
            votes_total: Schema.Number,
            verified: Schema.optionalWith(Schema.Boolean, {
              default: () => false,
            }),
            state: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
});

// Genius shows "?" for a song without an About text.
const aboutText = (song: typeof Song.Type) => {
  const plain = song.response.song.description?.plain.trim();
  return plain && plain !== '?' ? plain : null;
};

// Verified and accepted annotations first, then by votes. The description
// referent repeats the About text, so it is skipped.
export const annotationText = (referents: typeof Referents.Type) => {
  const rank = (a: { verified: boolean; state?: string }) =>
    a.verified ? 2 : a.state === 'accepted' ? 1 : 0;
  const notes = referents.response.referents
    .filter((r) => !r.is_description)
    .flatMap((r) => r.annotations.map((a) => ({ fragment: r.fragment, ...a })))
    .filter((a) => a.body.plain.trim() && a.body.plain.trim() !== '?')
    .sort((x, y) => rank(y) - rank(x) || y.votes_total - x.votes_total)
    .slice(0, MAX_ANNOTATIONS)
    .map((a) => `"${a.fragment.trim()}": ${a.body.plain.trim()}`);
  return notes.length ? notes.join('\n\n') : null;
};

interface Pending {
  readonly id: number;
  readonly title: string;
  readonly artist: string;
}

export const syncGenius = Effect.gen(function* () {
  const db = yield* Db;
  const token = yield* geniusToken;
  if (Option.isNone(token)) {
    yield* Effect.logWarning('genius: no GENIUS_ACCESS_TOKEN, skipped');
    return;
  }
  const pending = db
    .query<Pending, [number]>(
      `select t.id, t.title,
         (select a.name from track_artists ta join artists a on a.id = ta.artist_id
          where ta.track_id = t.id order by ta.position limit 1) as artist
       from tracks t left join genius g on g.track_id = t.id
       where (g.track_id is null or (g.status = 'miss' and g.fetched_at < ?))
         and (${ENRICH_TRACKS})
       order by exists (select 1 from track_sources s where s.track_id = t.id
                        and s.source in ('liked', 'playlist', 'top')) desc,
         (select count(*) from scrobbles sc where sc.track_id = t.id) desc`,
    )
    .all(Math.floor(Date.now() / 1000) - MISS_RETRY_SECONDS);

  const save = db.query(
    `insert into genius (track_id, status, genius_id, about, annotations, fetched_at)
     values (?, ?, ?, ?, ?, unixepoch())
     on conflict do update set status = excluded.status, genius_id = excluded.genius_id,
       about = excluded.about, annotations = excluded.annotations,
       fetched_at = excluded.fetched_at`,
  );
  let calls = 0;
  const spend = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    calls++;
    return Effect.zipLeft(effect, Effect.sleep(PACE));
  };

  let done = 0;
  let hits = 0;
  for (const track of pending) {
    // A song takes up to three calls; do not start one the budget cannot finish.
    if (calls + 3 > CALLS_PER_RUN) break;
    const song = yield* spend(findSong(track.title, track.artist, token.value));
    if (!song) {
      save.run(track.id, 'miss', null, null, null);
      done++;
      continue;
    }
    const details = yield* spend(
      geniusGet(
        Song,
        `songs/${song.id}`,
        { text_format: 'plain' },
        token.value,
      ),
    );
    const referents = yield* spend(
      geniusGet(
        Referents,
        'referents',
        { song_id: song.id, text_format: 'plain', per_page: 50 },
        token.value,
      ),
    );
    save.run(
      track.id,
      'hit',
      song.id,
      aboutText(details),
      annotationText(referents),
    );
    done++;
    hits++;
  }
  yield* Effect.logInfo(
    `genius: ${done} songs checked (${hits} on Genius) with ${calls} calls, ${pending.length - done} left`,
  );
});
