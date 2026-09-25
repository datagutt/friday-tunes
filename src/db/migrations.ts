// Applied in order and tracked with `pragma user_version`. Never edit a
// shipped migration; append a new one instead, because existing databases
// already hold the old shape.

export const EMBED_DIMS = 1024;

export const migrations: ReadonlyArray<string> = [
  `
  create table artists (
    id integer primary key,
    spotify_id text unique,
    name text not null,
    name_norm text not null,
    followed integer not null default 0,
    lastfm_playcount integer,
    lastfm_rank integer,
    tags_fetched_at integer,
    catalog_synced_at integer
  );
  create index artists_name_norm on artists(name_norm);

  -- One row per song, not per Spotify ID: album, single and remaster
  -- versions share a match_key and collapse here. spotify_id is the
  -- preferred playable version; track_spotify_ids maps every ID seen.
  create table tracks (
    id integer primary key,
    match_key text not null unique,
    spotify_id text,
    isrc text,
    title text not null,
    title_norm text not null,
    album text,
    album_spotify_id text,
    release_year integer,
    duration_ms integer,
    resolve_status text,
    resolved_at integer,
    tags_fetched_at integer,
    embed_hash text
  );
  create index tracks_spotify_id on tracks(spotify_id);

  create table track_spotify_ids (
    spotify_id text primary key,
    track_id integer not null references tracks(id) on delete cascade
  ) without rowid;

  create table track_artists (
    track_id integer not null references tracks(id) on delete cascade,
    artist_id integer not null references artists(id) on delete cascade,
    position integer not null,
    primary key (track_id, artist_id)
  ) without rowid;
  create index track_artists_artist on track_artists(artist_id);

  -- source_ref is the playlist ID for 'playlist', the time range for
  -- 'top', and the artist's Spotify ID for 'catalog'.
  create table track_sources (
    track_id integer not null references tracks(id) on delete cascade,
    source text not null,
    source_ref text not null default '',
    added_at integer,
    primary key (track_id, source, source_ref)
  ) without rowid;
  create index track_sources_ref on track_sources(source, source_ref);

  create table playlists (
    spotify_id text primary key,
    name text not null,
    owned integer not null,
    snapshot_id text,
    track_count integer,
    status text not null,
    synced_at integer
  );

  create table scrobbles (
    played_at integer not null,
    track_id integer not null references tracks(id) on delete cascade,
    primary key (played_at, track_id)
  ) without rowid;
  create index scrobbles_track on scrobbles(track_id);

  create view track_plays as
    select track_id, count(*) as plays, min(played_at) as first_played,
      max(played_at) as last_played
    from scrobbles group by track_id;

  create table top_snapshots (
    taken_at integer not null,
    kind text not null,
    time_range text not null,
    rank integer not null,
    spotify_id text not null,
    primary key (taken_at, kind, time_range, rank)
  ) without rowid;

  create table tags (
    entity text not null,
    entity_id integer not null,
    tag text not null,
    weight integer not null,
    primary key (entity, entity_id, tag)
  ) without rowid;
  create index tags_tag on tags(tag);

  create table lyrics (
    track_id integer primary key references tracks(id) on delete cascade,
    status text not null,
    source text,
    plain text,
    instrumental integer not null default 0,
    fetched_at integer not null
  );

  create virtual table tracks_fts using fts5(
    title, artists, album, tags, lyrics,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  create virtual table vec_tracks using vec0(
    track_id integer primary key,
    embedding float[${EMBED_DIMS}] distance_metric=cosine
  );

  create table sync_state (
    key text primary key,
    value text not null
  );
  `,
  `
  -- Spotify discographies fill in slowly, album by album, so progress is
  -- kept per album and an artist is done once every album is fetched.
  create table spotify_albums (
    spotify_id text primary key,
    artist_id integer not null references artists(id) on delete cascade,
    name text not null,
    release_date text,
    tracks_synced_at integer
  );
  create index spotify_albums_pending on spotify_albums(artist_id, tracks_synced_at);
  alter table artists add column spotify_albums_at integer;
  `,
  `
  -- Genius explains what a song is about: its About text and the
  -- listener annotations. That reaches themes that titles, tags and lyrics
  -- miss, like a song's backstory or hidden meaning.
  create table genius (
    track_id integer primary key references tracks(id) on delete cascade,
    status text not null,
    genius_id integer,
    about text,
    annotations text,
    fetched_at integer not null
  );

  drop table tracks_fts;
  create virtual table tracks_fts using fts5(
    title, artists, album, tags, lyrics, meaning,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];
