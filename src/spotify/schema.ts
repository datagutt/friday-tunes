import { Schema } from 'effect';

// Only the fields friday-tunes reads. Spotify removed several fields in
// 2026 (popularity, followers, genres for many artists), so none of those
// appear here.

export const Paging = <A, I>(item: Schema.Schema<A, I>) =>
  Schema.Struct({
    items: Schema.Array(item),
    next: Schema.NullOr(Schema.String),
    total: Schema.optional(Schema.Number),
  });

export const ArtistRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
});

export const AlbumRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
  release_date: Schema.optional(Schema.NullOr(Schema.String)),
});

export const Track = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
  duration_ms: Schema.Number,
  artists: Schema.Array(ArtistRef),
  album: Schema.optional(AlbumRef),
  external_ids: Schema.optional(
    Schema.Struct({ isrc: Schema.optional(Schema.String) }),
  ),
});
export type Track = typeof Track.Type;

export const SavedTrack = Schema.Struct({
  added_at: Schema.String,
  track: Track,
});

// The item stays unknown here because playlists can hold podcast episodes;
// sync decodes it as a Track and skips anything else.
export const PlaylistEntry = Schema.Struct({
  added_at: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(Schema.NullOr(Schema.Unknown)),
  track: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

const Count = Schema.optional(
  Schema.NullOr(Schema.Struct({ total: Schema.optional(Schema.Number) })),
);

export const Playlist = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  collaborative: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  snapshot_id: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.Struct({ id: Schema.String }),
  // `/me/playlists` moved the count from `tracks` to `items` in March 2026.
  items: Count,
  tracks: Count,
});

export const Me = Schema.Struct({ id: Schema.String });

export const PlayHistory = Schema.Struct({
  played_at: Schema.String,
  track: Track,
});

export const RecentlyPlayed = Schema.Struct({
  items: Schema.Array(PlayHistory),
});

export const FollowedArtists = Schema.Struct({
  artists: Schema.Struct({
    items: Schema.Array(ArtistRef),
    next: Schema.NullOr(Schema.String),
  }),
});

export const SimplifiedAlbum = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  album_type: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.NullOr(Schema.String)),
});

export const SearchTracks = Schema.Struct({
  tracks: Schema.Struct({ items: Schema.Array(Schema.NullOr(Track)) }),
});

export const CreatedPlaylist = Schema.Struct({
  id: Schema.String,
  external_urls: Schema.Struct({ spotify: Schema.String }),
});

export const releaseYear = (date: string | null | undefined) => {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
};
