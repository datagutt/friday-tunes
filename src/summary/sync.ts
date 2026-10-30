import { Clock, Effect, Schema } from 'effect';
import { ollama } from '../config';
import { Db } from '../db/db';
import { chatJson, embed } from '../embed/ollama';
import { ENRICH_TRACKS } from '../lastfm/sync';

// Enough of the song for its subject; long inputs mostly slow the model.
const LYRICS_CHARS = 2500;
const NOTES_CHARS = 1500;
const EMBED_BATCH = 16;

// The themes are written the way people phrase Friday themes, so a query
// like "songs about war" lands on them directly.
export const SYSTEM = `You write entries for a search index that finds songs for themed playlists.
Given a song's title, artist, lyrics and listener notes, reply with only a JSON object with these keys:
- summary: at most 2 plain English sentences, under 60 words, on what the song is about: its subject, story, references and tone (sarcastic, angry, tender). Name the real people, places and events it is about. Say what it is about underneath when the surface differs (a cheerful tune about nuclear war). No praise, chart history or release trivia.
- themes: 5 to 8 short playlist themes it would fit, phrased as people name themes ("songs about war", "breakup songs", "songs about Christmas", "songs that mention a city"). Include wordplay hooks from the title.
- language: the two-letter ISO 639-1 code of the lyrics (en, no, de), or "zxx" without lyrics.
Write in English even when the lyrics are not. Base everything on the given text and well-known facts about the song. If you cannot tell, keep the summary short.`;

// Empty values are dropped after decoding.
export const Summary = Schema.Struct({
  summary: Schema.String,
  themes: Schema.Array(Schema.String),
  language: Schema.String,
});

export interface SummarySource {
  readonly id: number;
  readonly title: string;
  readonly artists: string | null;
  readonly album: string | null;
  readonly year: number | null;
  readonly tags: string | null;
  readonly lyrics: string | null;
  readonly about: string | null;
  readonly annotations: string | null;
  readonly input_hash: string | null;
}

export const summaryInput = (s: SummarySource) =>
  [
    `title: ${s.title}`,
    `artist: ${s.artists ?? ''}`,
    s.album ? `album: ${s.album}${s.year ? ` (${s.year})` : ''}` : null,
    s.tags ? `tags: ${s.tags}` : null,
    s.lyrics ? `lyrics:\n${s.lyrics.slice(0, LYRICS_CHARS)}` : null,
    s.about ? `about:\n${s.about.slice(0, NOTES_CHARS)}` : null,
    s.annotations ? `notes:\n${s.annotations.slice(0, NOTES_CHARS)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

// The text that gets embedded for the about-vibe search.
export const summaryEmbedText = (summary: string, themes: string) =>
  `${summary}\nthemes: ${themes.replaceAll('\n', '; ')}`;

const hash = (text: string) => Bun.hash(text).toString(36);

// Only songs with lyrics or Genius notes: from a title alone the model
// guesses, and a confident wrong summary is worse than none. Library songs
// go first, then the most played. Without a time limit it runs until every
// song is done.
export const syncSummaries = (maxMinutes?: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const { summaryModel } = yield* ollama;
    const sources = db
      .query<SummarySource, []>(
        `select t.id, t.title, t.album, t.release_year as year, s.input_hash,
         (select group_concat(name, ', ') from (
           select a.name from track_artists ta join artists a on a.id = ta.artist_id
           where ta.track_id = t.id order by ta.position)) as artists,
         (select group_concat(tag, ', ') from (
           select tag from tags where entity = 'track' and entity_id = t.id
           order by weight desc limit 10)) as tags,
         l.plain as lyrics, g.about, g.annotations
       from tracks t
         left join lyrics l on l.track_id = t.id and l.status = 'hit' and l.instrumental = 0
         left join genius g on g.track_id = t.id
         left join summaries s on s.track_id = t.id
       where (l.plain is not null or g.about is not null or g.annotations is not null)
         and (${ENRICH_TRACKS})
       order by exists (select 1 from track_sources ts where ts.track_id = t.id
                        and ts.source in ('liked', 'playlist', 'top')) desc,
         (select count(*) from scrobbles sc where sc.track_id = t.id) desc`,
      )
      .all();
    const pending = sources
      .map((s) => {
        const input = summaryInput(s);
        return {
          id: s.id,
          input,
          hash: hash(`${summaryModel}\n${SYSTEM}\n${input}`),
          old: s.input_hash,
        };
      })
      .filter((p) => p.hash !== p.old);
    yield* Effect.logInfo(`summaries: ${pending.length} tracks to summarize`);

    const save = db.query(
      `insert into summaries (track_id, status, summary, themes, language, input_hash, created_at)
     values (?, ?, ?, ?, ?, ?, unixepoch())
     on conflict do update set status = excluded.status, summary = excluded.summary,
       themes = excluded.themes, language = excluded.language,
       input_hash = excluded.input_hash, created_at = excluded.created_at`,
    );
    const removeVector = db.query(
      'delete from vec_summaries where track_id = ?',
    );
    const insertVector = db.query(
      'insert into vec_summaries (track_id, embedding) values (?, ?)',
    );

    interface Hit {
      readonly id: number;
      readonly hash: string;
      readonly summary: string;
      readonly themes: string;
      readonly language: string;
    }
    let hits: Hit[] = [];
    const flush = Effect.gen(function* () {
      if (hits.length === 0) return;
      const vectors = yield* embed(
        hits.map((h) => summaryEmbedText(h.summary, h.themes)),
      );
      const batch = hits;
      hits = [];
      db.transaction(() => {
        batch.forEach((h, i) => {
          save.run(h.id, 'hit', h.summary, h.themes, h.language, h.hash);
          removeVector.run(h.id);
          insertVector.run(BigInt(h.id), vectors[i] ?? null);
        });
      })();
    });

    const start = yield* Clock.currentTimeMillis;
    let done = 0;
    let misses = 0;
    for (const track of pending) {
      if (
        maxMinutes !== undefined &&
        (yield* Clock.currentTimeMillis) - start > maxMinutes * 60_000
      )
        break;
      // Output that breaks the shape is a miss for this input, so the song is
      // tried again only when its text, the prompt or the model changes.
      // Ollama being down fails the step instead.
      const result = yield* chatJson(Summary, SYSTEM, track.input).pipe(
        Effect.map((s) => ({
          summary: s.summary.trim(),
          themes: s.themes
            .map((t) => t.trim())
            .filter(Boolean)
            .join('\n'),
          language: s.language.trim().toLowerCase(),
        })),
        Effect.catchTag('ParseError', () => Effect.succeed(undefined)),
      );
      if (result?.summary && result.themes) {
        hits.push({ id: track.id, hash: track.hash, ...result });
        if (hits.length >= EMBED_BATCH) yield* flush;
      } else {
        save.run(track.id, 'miss', null, null, null, track.hash);
        removeVector.run(track.id);
        misses++;
      }
      done++;
      if (done % 50 === 0) {
        const seconds = ((yield* Clock.currentTimeMillis) - start) / 1000;
        yield* Effect.logInfo(
          `summaries: ${done}/${pending.length} (${(seconds / done).toFixed(1)} s per track)`,
        );
      }
    }
    yield* flush;
    yield* Effect.logInfo(
      `summaries: ${done} written, ${misses} unusable, ${pending.length - done} left for the next run`,
    );
  });
