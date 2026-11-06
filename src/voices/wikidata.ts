import { Duration, Effect, Schema } from 'effect';
import { Db } from '../db/db';
import { requestJson, retryTransient } from '../http';
import {
  combineVoices,
  type PendingArtist,
  pendingVoices,
  saveVoice,
  type Voice,
} from './voices';

const API = 'https://www.wikidata.org/w/api.php';
// Both the statement search and the entity lookup take at most 50 at a
// time. The query service (SPARQL) would answer in one call, but it is
// often rate limited to one query a minute; this API is not.
const BATCH = 50;
const PACE = Duration.seconds(1);

const SPOTIFY_ARTIST_ID = 'P1902';
const GENIUS_ARTIST_ID = 'P6351';
const INSTANCE_OF = 'P31';
const GENDER = 'P21';
const HAS_PARTS = 'P527';
const OCCUPATION = 'P106';
const INSTRUMENT = 'P1303';
const HUMAN = 'Q5';

const GENDERS: Record<string, Voice> = {
  Q6581072: 'female',
  Q1052281: 'female', // trans woman
  Q6581097: 'male',
  Q2449503: 'male', // trans man
  Q48270: 'nonbinary',
};

// A band member counts as a singer when Wikidata lists a singing
// occupation or the voice as their instrument. Members who only play
// (Talking Heads' bassist) say nothing about how the band sounds.
const SINGING = new Set([
  'Q177220', // singer
  'Q488205', // singer-songwriter
  'Q2252262', // rapper
  'Q2643890', // vocalist
  'Q17172850', // voice, as an instrument
]);

const Search = Schema.Struct({
  query: Schema.Struct({
    search: Schema.Array(Schema.Struct({ title: Schema.String })),
  }),
});

const Snak = Schema.Struct({
  mainsnak: Schema.Struct({
    datavalue: Schema.optional(Schema.Struct({ value: Schema.Unknown })),
  }),
});

const Entities = Schema.Struct({
  entities: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      claims: Schema.optional(
        Schema.Record({ key: Schema.String, value: Schema.Array(Snak) }),
      ),
    }),
  }),
});
type Entity = (typeof Entities.Type)['entities'][string];

const get = <A, I>(
  schema: Schema.Schema<A, I>,
  params: Record<string, string>,
) => {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ ...params, format: 'json' })) {
    url.searchParams.set(key, value);
  }
  return retryTransient(requestJson('wikidata', url.toString())).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.zipLeft(Effect.sleep(PACE)),
  );
};

// Item claims hold {id}, external IDs hold a plain string.
export const claimValues = (entity: Entity | undefined, property: string) =>
  (entity?.claims?.[property] ?? []).flatMap((claim) => {
    const value = claim.mainsnak.datavalue?.value;
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object' && 'id' in value)
      return [String(value.id)];
    return [];
  });

const personVoice = (entity: Entity | undefined) =>
  claimValues(entity, GENDER)
    .map((g) => GENDERS[g])
    .find((v) => v !== undefined) ?? null;

const sings = (member: Entity | undefined) =>
  [...claimValues(member, OCCUPATION), ...claimValues(member, INSTRUMENT)].some(
    (q) => SINGING.has(q),
  );

const fetchEntities = (ids: ReadonlyArray<string>) =>
  Effect.forEach(chunk(ids, BATCH), (batch) =>
    get(Entities, {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'claims',
    }),
  ).pipe(
    Effect.map(
      (results) =>
        Object.assign({}, ...results.map((r) => r.entities)) as Record<
          string,
          Entity
        >,
    ),
  );

const chunk = <T>(items: ReadonlyArray<T>, size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const statements = (artist: PendingArtist) => [
  ...(artist.spotify_id ? [`${SPOTIFY_ARTIST_ID}=${artist.spotify_id}`] : []),
  ...(artist.genius_id ? [`${GENIUS_ARTIST_ID}=${artist.genius_id}`] : []),
];

// Groups artists so each search holds at most BATCH statements.
const batches = (artists: ReadonlyArray<PendingArtist>) => {
  const result: PendingArtist[][] = [];
  let current: PendingArtist[] = [];
  let size = 0;
  for (const artist of artists) {
    const n = statements(artist).length;
    if (size + n > BATCH) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(artist);
    size += n;
  }
  if (current.length) result.push(current);
  return result;
};

// Finds each artist's item by its Spotify or Genius ID, then reads the
// gender of a person or the genders of a band's singing members.
const lookup = (artists: ReadonlyArray<PendingArtist>) =>
  Effect.gen(function* () {
    const search = yield* get(Search, {
      action: 'query',
      list: 'search',
      srsearch: `haswbstatement:${artists.flatMap(statements).join('|')}`,
      srlimit: String(BATCH),
      srprop: '',
    });
    const items = yield* fetchEntities(search.query.search.map((s) => s.title));
    const members = yield* fetchEntities([
      ...new Set(
        Object.values(items)
          .filter((item) => !claimValues(item, INSTANCE_OF).includes(HUMAN))
          .flatMap((item) => claimValues(item, HAS_PARTS)),
      ),
    ]);
    const bySpotify = new Map<string, Entity>();
    const byGenius = new Map<string, Entity>();
    for (const item of Object.values(items)) {
      for (const id of claimValues(item, SPOTIFY_ARTIST_ID))
        bySpotify.set(id, item);
      for (const id of claimValues(item, GENIUS_ARTIST_ID))
        byGenius.set(id, item);
    }
    return artists.map((artist) => {
      const item =
        (artist.spotify_id ? bySpotify.get(artist.spotify_id) : undefined) ??
        (artist.genius_id ? byGenius.get(String(artist.genius_id)) : undefined);
      if (!item) return { artist, voice: null };
      if (claimValues(item, INSTANCE_OF).includes(HUMAN))
        return { artist, voice: personVoice(item) };
      const singers = claimValues(item, HAS_PARTS)
        .map((id) => members[id])
        .filter(sings);
      return { artist, voice: combineVoices(singers.map(personVoice)) };
    });
  });

export const syncWikidataVoices = Effect.gen(function* () {
  const db = yield* Db;
  const pending = pendingVoices(
    db,
    'wikidata',
    'a.spotify_id is not null or a.genius_id is not null',
  );
  let found = 0;
  for (const batch of batches(pending)) {
    for (const { artist, voice } of yield* lookup(batch)) {
      saveVoice(db, artist.id, 'wikidata', voice);
      if (voice) found++;
    }
  }
  yield* Effect.logInfo(
    `voices: ${pending.length} artists checked on Wikidata (${found} with a voice)`,
  );
});
