import { Effect, type Redacted, Schema } from 'effect';
import { pendingBios, saveBio } from '../db/bios';
import { Db } from '../db/db';
import { normalizeArtist } from '../normalize';
import type { Budget } from './budget';
import { geniusGet } from './client';

const Search = Schema.Struct({
  response: Schema.Struct({
    hits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        result: Schema.Struct({
          primary_artist: Schema.Struct({
            id: Schema.Number,
            name: Schema.String,
          }),
        }),
      }),
    ),
  }),
});

const Artist = Schema.Struct({
  response: Schema.Struct({
    artist: Schema.Struct({
      description: Schema.optional(
        Schema.NullOr(Schema.Struct({ plain: Schema.String })),
      ),
    }),
  }),
});

// Genius has no artist search, so the artist comes from song hits. Its
// search ranks popular songs first, which also surfaces features by other
// artists, so the name must match exactly.
const findArtistId = (name: string, token: Redacted.Redacted, budget: Budget) =>
  budget.spend(geniusGet(Search, 'search', { q: name }, token)).pipe(
    Effect.map((search) => {
      const wanted = normalizeArtist(name);
      return search.response.hits.find(
        (h) =>
          h.type === 'song' &&
          normalizeArtist(h.result.primary_artist.name) === wanted,
      )?.result.primary_artist.id;
    }),
  );

// Genius shows "?" for an artist without a description.
const descriptionText = (artist: typeof Artist.Type) => {
  const plain = artist.response.artist.description?.plain.trim();
  return plain && plain !== '?' ? plain : null;
};

export const syncGeniusArtists = (token: Redacted.Redacted, budget: Budget) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const pending = pendingBios(db, 'genius');
    let done = 0;
    let hits = 0;
    for (const artist of pending) {
      if (!budget.canAfford(2)) break;
      const id = yield* findArtistId(artist.name, token, budget);
      const bio =
        id === undefined
          ? null
          : descriptionText(
              yield* budget.spend(
                geniusGet(
                  Artist,
                  `artists/${id}`,
                  { text_format: 'plain' },
                  token,
                ),
              ),
            );
      saveBio(db, artist.id, 'genius', bio);
      done++;
      if (bio) hits++;
    }
    yield* Effect.logInfo(
      `genius: ${done} artists checked (${hits} with a bio), ${pending.length - done} left`,
    );
  });
