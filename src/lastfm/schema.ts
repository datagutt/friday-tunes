import { Schema } from 'effect';

// Last.fm returns a single object instead of a one-element array when a
// list has exactly one entry, and numbers as strings.
export const List = <A, I>(item: Schema.Schema<A, I>) =>
  Schema.optionalWith(
    Schema.transform(
      Schema.Union(Schema.Array(item), item),
      Schema.typeSchema(Schema.Array(item)),
      {
        strict: true,
        decode: (value) => (Array.isArray(value) ? value : [value as A]),
        encode: (value) => value,
      },
    ),
    { default: () => [] },
  );

const Text = Schema.Struct({ '#text': Schema.String });

export const Scrobble = Schema.Struct({
  name: Schema.String,
  artist: Text,
  album: Schema.optional(Text),
  date: Schema.optional(Schema.Struct({ uts: Schema.NumberFromString })),
  '@attr': Schema.optional(Schema.Struct({ nowplaying: Schema.String })),
});
export type Scrobble = typeof Scrobble.Type;

const PageAttr = Schema.Struct({
  page: Schema.NumberFromString,
  totalPages: Schema.NumberFromString,
  total: Schema.NumberFromString,
});

export const RecentTracks = Schema.Struct({
  recenttracks: Schema.Struct({
    track: List(Scrobble),
    '@attr': PageAttr,
  }),
});

export const TopArtists = Schema.Struct({
  topartists: Schema.Struct({
    artist: List(
      Schema.Struct({
        name: Schema.String,
        playcount: Schema.NumberFromString,
        '@attr': Schema.Struct({ rank: Schema.NumberFromString }),
      }),
    ),
  }),
});

export const TopTags = Schema.Struct({
  toptags: Schema.Struct({
    tag: List(
      Schema.Struct({
        name: Schema.String,
        count: Schema.Union(Schema.Number, Schema.NumberFromString),
      }),
    ),
  }),
});
