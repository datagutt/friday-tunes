import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { Db, DbMemory } from '../src/db/db';
import { addSource, upsertTrack } from '../src/db/library';
import { rebuildFts } from '../src/search/fts';
import { search } from '../src/search/search';
import { syncSummaries } from '../src/summary/sync';
import { runWithClock, scriptFetch, testConfig } from './helpers';

const layer = DbMemory.pipe(Layer.provide(testConfig({})));

const reply = (content: unknown) => ({
  message: {
    content: typeof content === 'string' ? content : JSON.stringify(content),
  },
});

test('summarizes songs with text, records unusable replies, and skips done songs', async () => {
  const http = scriptFetch([
    // Models wrap the object in a code fence even when told not to.
    {
      url: '/api/chat',
      json: reply(
        `\`\`\`json\n${JSON.stringify({
          summary: ' A cheerful synth-pop song about fearing nuclear war. ',
          themes: ['songs about war', ' ', 'cold war songs'],
          language: 'EN',
        })}\n\`\`\``,
      ),
    },
    { url: '/api/chat', json: reply('{"summary": "cut off') },
    {
      url: '/api/embed',
      json: { embeddings: [Array.from({ length: 1024 }, () => 0.1)] },
    },
  ]);

  const result = await runWithClock(
    Effect.gen(function* () {
      const db = yield* Db;
      const lyrics = db.query(
        "insert into lyrics (track_id, status, plain, fetched_at) values (?, 'hit', ?, 0)",
      );
      const track = (title: string, artist: string, text?: string) => {
        const id = upsertTrack(db, { title, artists: [{ name: artist }] });
        addSource(db, id, 'liked');
        if (text) lyrics.run(id, text);
      };
      track(
        'Forever Young',
        'Alphaville',
        'Let us die young or let us live forever',
      );
      track('Garbled', 'Someone', 'La la la');
      track('No Text', 'Nobody');

      yield* syncSummaries;
      // Nothing changed, so a second run asks the model nothing.
      yield* syncSummaries;
      rebuildFts(db);
      return {
        rows: db
          .query(
            'select status, summary, themes, language from summaries order by track_id',
          )
          .all(),
        vectors: db
          .query<{ n: number }, []>('select count(*) as n from vec_summaries')
          .get()?.n,
        about: search(db, {
          mode: 'about',
          query: 'nuclear',
          limit: 5,
          source: 'any',
          minPlays: 0,
          substring: false,
        }).map((r) => [r.title, r.about]),
      };
    }).pipe(Effect.provide(layer)),
  );

  http.done();
  expect(result.rows).toEqual([
    {
      status: 'hit',
      summary: 'A cheerful synth-pop song about fearing nuclear war.',
      themes: 'songs about war\ncold war songs',
      language: 'en',
    },
    { status: 'miss', summary: null, themes: null, language: null },
  ]);
  expect(result.vectors).toBe(1);
  expect(result.about).toEqual([
    ['Forever Young', 'A cheerful synth-pop song about fearing nuclear war.'],
  ]);
});
