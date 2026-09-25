import { Effect } from 'effect';
import { Db } from '../db/db';
import { embed } from './ollama';

const BATCH = 64;
// Enough lyrics to carry a song's subject; more mostly slows embedding.
const LYRICS_CHARS = 1500;
const MEANING_CHARS = 1500;

interface Source {
  readonly id: number;
  readonly title: string;
  readonly artists: string | null;
  readonly album: string | null;
  readonly year: number | null;
  readonly tags: string | null;
  readonly lyrics: string | null;
  readonly meaning: string | null;
  readonly embed_hash: string | null;
}

// The embedded text mirrors what a theme can describe: title words, who
// made it, genre and mood tags, the lyrics, and what Genius says the song
// is about.
export const embedText = (s: Source) =>
  [
    `title: ${s.title}`,
    `artist: ${s.artists ?? ''}`,
    s.album ? `album: ${s.album}${s.year ? ` (${s.year})` : ''}` : null,
    s.tags ? `tags: ${s.tags}` : null,
    s.lyrics ? `lyrics: ${s.lyrics.slice(0, LYRICS_CHARS)}` : null,
    s.meaning ? `about: ${s.meaning.slice(0, MEANING_CHARS)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

const hash = (text: string) => Bun.hash(text).toString(36);

// Library tracks go first, so an interrupted run already covers the songs
// themes pick most. Re-running only embeds tracks whose text changed.
export const syncEmbeddings = Effect.gen(function* () {
  const db = yield* Db;
  const sources = db
    .query<Source, []>(
      `select t.id, t.title, t.album, t.release_year as year, t.embed_hash,
         (select group_concat(name, ', ') from (
           select a.name from track_artists ta join artists a on a.id = ta.artist_id
           where ta.track_id = t.id order by ta.position)) as artists,
         (select group_concat(tag, ', ') from (
           select tag, max(weight) as w from (
             select tag, weight from tags where entity = 'track' and entity_id = t.id
             union all
             select g.tag, g.weight / 2 from tags g join track_artists ta
               on g.entity = 'artist' and g.entity_id = ta.artist_id
             where ta.track_id = t.id and ta.position = 0)
           group by tag order by w desc limit 15)) as tags,
         (select plain from lyrics l where l.track_id = t.id and l.status = 'hit') as lyrics,
         (select nullif(concat_ws(char(10, 10), g.about, g.annotations), '')
          from genius g where g.track_id = t.id) as meaning
       from tracks t
       order by exists (select 1 from track_sources s where s.track_id = t.id
                        and s.source in ('liked', 'playlist', 'top')) desc, t.id`,
    )
    .all();

  const pending = sources
    .map((s) => ({ id: s.id, text: embedText(s), old: s.embed_hash }))
    .map((p) => ({ ...p, hash: hash(p.text) }))
    .filter((p) => p.hash !== p.old);
  yield* Effect.logInfo(`embeddings: ${pending.length} tracks to embed`);

  const remove = db.query('delete from vec_tracks where track_id = ?');
  const insert = db.query(
    'insert into vec_tracks (track_id, embedding) values (?, ?)',
  );
  const mark = db.query('update tracks set embed_hash = ? where id = ?');
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = yield* embed(batch.map((p) => p.text));
    db.transaction(() => {
      batch.forEach((p, j) => {
        remove.run(p.id);
        insert.run(BigInt(p.id), vectors[j] ?? null);
        mark.run(p.hash, p.id);
      });
    })();
    const done = Math.min(i + BATCH, pending.length);
    if (done % (BATCH * 40) === 0 || done === pending.length) {
      yield* Effect.logInfo(`embeddings: ${done}/${pending.length}`);
    }
  }
});
