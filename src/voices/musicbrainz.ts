import { Duration, Effect, Schema } from 'effect';
import { type Budget, makeBudget } from '../budget';
import { Db } from '../db/db';
import { requestJson, retryTransient } from '../http';
import { combineVoices, pendingVoices, saveVoice, type Voice } from './voices';

const API = 'https://musicbrainz.org/ws/2/';
// MusicBrainz allows one request per second. A person takes two calls and
// a band one more per singing member, so a run covers a few hundred
// artists and the hourly job fills the rest in over a day.
const PACE = Duration.millis(1100);
const CALLS_PER_RUN = 900;

const ArtistRef = Schema.Struct({ id: Schema.String });

const UrlLookup = Schema.Struct({
  relations: Schema.Array(
    Schema.Struct({
      'target-type': Schema.String,
      artist: Schema.optional(ArtistRef),
    }),
  ),
});

const Artist = Schema.Struct({
  type: Schema.NullOr(Schema.String),
  gender: Schema.optional(Schema.NullOr(Schema.String)),
  relations: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        direction: Schema.String,
        attributes: Schema.optionalWith(Schema.Array(Schema.String), {
          default: () => [],
        }),
        artist: Schema.optional(ArtistRef),
      }),
    ),
    { default: () => [] },
  ),
});
type Artist = typeof Artist.Type;

const GENDERS: Record<string, Voice> = {
  female: 'female',
  male: 'male',
  'non-binary': 'nonbinary',
};

const get = <A, I>(
  schema: Schema.Schema<A, I>,
  path: string,
  params: Record<string, string>,
) => {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries({ ...params, fmt: 'json' })) {
    url.searchParams.set(key, value);
  }
  return retryTransient(requestJson('musicbrainz', url.toString())).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
  );
};

const personVoice = (artist: Artist) =>
  GENDERS[artist.gender?.toLowerCase() ?? ''] ?? null;

// Band members whose membership lists any kind of vocals, such as "lead
// vocals". Members who only play an instrument are left out.
export const singingMembers = (band: Artist) =>
  band.relations.flatMap((r) =>
    r.type === 'member of band' &&
    r.direction === 'backward' &&
    r.artist &&
    r.attributes.some((a) => a.includes('vocals'))
      ? [r.artist.id]
      : [],
  );

const voiceOf = (spotifyId: string, budget: Budget) =>
  Effect.gen(function* () {
    // The Spotify link is the only safe key: a name search for "Bastian!"
    // finds a German comedian.
    const link = yield* budget
      .spend(
        get(UrlLookup, 'url', {
          resource: `https://open.spotify.com/artist/${spotifyId}`,
          inc: 'artist-rels',
        }),
      )
      .pipe(
        Effect.catchIf(
          (e) => e._tag === 'HttpError' && e.status === 404,
          () => Effect.succeed(null),
        ),
      );
    const id = link?.relations.find((r) => r['target-type'] === 'artist')
      ?.artist?.id;
    if (!id) return null;
    const artist = yield* budget.spend(
      get(Artist, `artist/${id}`, { inc: 'artist-rels' }),
    );
    if (artist.type !== 'Group') return personVoice(artist);
    const members = yield* Effect.forEach(singingMembers(artist), (member) =>
      budget.spend(get(Artist, `artist/${member}`, {})),
    );
    return combineVoices(members.map(personVoice));
  });

// Only artists Wikidata could not place: MusicBrainz is slower, and
// Wikidata covers the well-known ones.
export const syncMusicBrainzVoices = Effect.gen(function* () {
  const db = yield* Db;
  const pending = pendingVoices(
    db,
    'musicbrainz',
    `a.spotify_id is not null and not exists (
       select 1 from artist_voices w where w.artist_id = a.id
         and w.source in ('wikidata', 'manual') and w.voice is not null)`,
  );
  const budget = makeBudget(CALLS_PER_RUN, PACE);
  let done = 0;
  let found = 0;
  for (const artist of pending) {
    // A band with several singers takes up to five calls.
    if (!budget.canAfford(5) || !artist.spotify_id) break;
    const voice = yield* voiceOf(artist.spotify_id, budget);
    saveVoice(db, artist.id, 'musicbrainz', voice);
    done++;
    if (voice) found++;
  }
  yield* Effect.logInfo(
    `voices: ${done} artists checked on MusicBrainz (${found} with a voice) with ${budget.used} calls, ${pending.length - done} left`,
  );
});
