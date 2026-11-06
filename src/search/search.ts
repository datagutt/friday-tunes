import type { Database } from 'bun:sqlite';
import { normalizeTitle } from '../normalize';
import type { Vocals } from '../voices/voices';

export const MODES = [
  'title',
  'artist',
  'album',
  'lyrics',
  'tag',
  'meaning',
  'about',
  'year',
  'vibe',
  'artist-vibe',
  'about-vibe',
] as const;
export type Mode = (typeof MODES)[number];

export const SOURCE_FILTERS = [
  'any',
  'liked',
  'library',
  'scrobbled',
  'catalog',
] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

export interface SearchOptions {
  readonly mode: Mode;
  readonly query: string;
  readonly limit: number;
  readonly source: SourceFilter;
  readonly minPlays: number;
  readonly substring: boolean;
  /** Tracks whose own or artist tags match any of these are left out. */
  readonly excludeTags?: ReadonlyArray<string>;
  /** Leave out tracks Spotify marks explicit. Unknown ones stay. */
  readonly clean?: boolean;
  /** Only tracks whose singers add up to this. Unknown ones are left out. */
  readonly vocals?: Vocals;
  /** Query embedding; required for the vibe modes. */
  readonly vector?: Float32Array;
  /**
   * Artist vibe: picks each artist's tracks by closeness to this embedding
   * instead of by plays.
   */
  readonly trackVector?: Float32Array;
}

export const VIBE_MODES: ReadonlySet<Mode> = new Set([
  'vibe',
  'artist-vibe',
  'about-vibe',
]);

// How many of the closest artists an artist vibe search draws tracks from,
// and how many tracks each one contributes. A few per artist keeps one
// prolific artist from filling the list.
const VIBE_ARTISTS = 60;
const TRACKS_PER_ARTIST = 4;

export interface Row {
  readonly id: number;
  readonly title: string;
  readonly artists: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly spotify_id: string | null;
  readonly spotify_url: string | null;
  readonly plays: number;
  readonly explicit: boolean | null;
  /** Whether women, men or both sing, where the voices step knows. */
  readonly vocals: Vocals | null;
  readonly sources: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  /** What the song is about, from the summary step. */
  readonly about?: string;
  readonly match?: string;
  readonly distance?: number;
}

// "library" means songs the user keeps on Spotify, as opposed to songs that
// only show up in scrobbles or artist catalogs.
const LIBRARY_SOURCES = "('liked', 'playlist', 'top')";

const sourceFilter: Record<SourceFilter, string> = {
  any: '1',
  liked:
    "exists (select 1 from track_sources s where s.track_id = t.id and s.source = 'liked')",
  library: `exists (select 1 from track_sources s where s.track_id = t.id and s.source in ${LIBRARY_SOURCES})`,
  scrobbled: 'exists (select 1 from scrobbles sc where sc.track_id = t.id)',
  // Last.fm top tracks and Spotify discographies of followed and top artists.
  catalog:
    "exists (select 1 from track_sources s where s.track_id = t.id and s.source in ('catalog', 'discography'))",
};

// Sources small enough for an exact vector scan instead of KNN.
const SMALL_SOURCES: ReadonlySet<SourceFilter> = new Set(['liked', 'library']);

const FTS_COLUMN: Partial<Record<Mode, string>> = {
  title: 'title',
  artist: 'artists',
  album: 'album',
  lyrics: 'lyrics',
  meaning: 'meaning',
  about: 'about',
  tag: 'tags',
};

// Positions of the long text columns in tracks_fts.
const SNIPPET_COLUMNS: Partial<Record<Mode, number>> = {
  lyrics: 4,
  meaning: 5,
  about: 6,
};

// Quotes every token so user input cannot inject FTS5 operators. A trailing
// `*` is kept as a prefix match.
export const ftsQuery = (column: string, query: string) => {
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const prefix = token.endsWith('*');
      const word = (prefix ? token.slice(0, -1) : token).replaceAll('"', '""');
      return `"${word}"${prefix ? '*' : ''}`;
    });
  if (tokens.length === 0) throw new Error('Search query is empty');
  return `${column} : (${tokens.join(' AND ')})`;
};

// Matches the tag as a phrase, so "metal" also drops "power metal" and
// "hip hop" does not drop a track tagged "hip" and "hop" separately.
export const tagPhraseQuery = (tags: ReadonlyArray<string>) =>
  `tags : (${tags.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')})`;

const parseYears = (query: string): [number, number] => {
  const match = query.trim().match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);
  if (!match?.[1])
    throw new Error('Year query must look like 1996 or 1990-1999');
  return [Number(match[1]), Number(match[2] ?? match[1])];
};

const ROW_COLUMNS = `
  t.id, t.title, t.album, t.release_year as year, t.spotify_id, t.explicit, t.vocals,
  (select group_concat(name, ', ') from (
    select a.name from track_artists ta join artists a on a.id = ta.artist_id
    where ta.track_id = t.id order by ta.position)) as artists,
  (select count(*) from scrobbles sc where sc.track_id = t.id) as plays,
  (select group_concat(distinct source) from track_sources s where s.track_id = t.id) as sources,
  (select group_concat(tag, ', ') from (
    select tag from tags where entity = 'track' and entity_id = t.id
    order by weight desc limit 5)) as tags,
  (select summary from summaries sm where sm.track_id = t.id and sm.status = 'hit') as about,
  exists (select 1 from track_sources s where s.track_id = t.id and s.source in ${LIBRARY_SOURCES}) as in_library`;

interface RawRow
  extends Omit<Row, 'sources' | 'tags' | 'spotify_url' | 'about' | 'explicit'> {
  explicit: number | null;
  sources: string | null;
  tags: string | null;
  about: string | null;
  in_library: number;
}

const toRow = ({
  in_library: _,
  sources,
  tags,
  about,
  match,
  ...rest
}: RawRow): Row => ({
  ...rest,
  explicit: rest.explicit === null ? null : rest.explicit === 1,
  artists: rest.artists ?? '',
  spotify_url: rest.spotify_id
    ? `https://open.spotify.com/track/${rest.spotify_id}`
    : null,
  sources: sources ? sources.split(',') : [],
  tags: tags ? tags.split(', ') : [],
  ...(about ? { about } : {}),
  ...(match ? { match } : {}),
});

export const search = (db: Database, options: SearchOptions): Row[] => {
  const params: Record<string, string | number | Float32Array> = {
    limit: options.limit,
  };
  const where = [sourceFilter[options.source]];
  if (options.minPlays > 0) {
    params.min_plays = options.minPlays;
    where.push(
      '(select count(*) from scrobbles sc where sc.track_id = t.id) >= $min_plays',
    );
  }
  const excludeTags = options.excludeTags?.filter((t) => t.trim()) ?? [];
  if (excludeTags.length > 0) {
    params.exclude = tagPhraseQuery(excludeTags);
    where.push(
      't.id not in (select rowid from tracks_fts where tracks_fts match $exclude)',
    );
  }
  if (options.clean) where.push('coalesce(t.explicit, 0) = 0');
  if (options.vocals) {
    params.vocals = options.vocals;
    where.push('t.vocals = $vocals');
  }

  let from = 'tracks t';
  let extra = '';
  // Plays come first: they show which songs the user actually knows, while
  // the library also holds imported playlists the user never played.
  let order = 'plays desc, in_library desc';
  const column = FTS_COLUMN[options.mode];

  if (options.mode === 'year') {
    const [from_year, to_year] = parseYears(options.query);
    where.push('t.release_year between $from_year and $to_year');
    Object.assign(params, { from_year, to_year });
  } else if (options.mode === 'title' && options.substring) {
    where.push("t.title_norm like $like escape '\\'");
    params.like = `%${normalizeTitle(options.query).replace(/[\\%_]/g, '\\$&')}%`;
  } else if (column) {
    from = 'tracks_fts f join tracks t on t.id = f.rowid';
    where.push('tracks_fts match $fts');
    params.fts = ftsQuery(column, options.query);
    // Long text columns show where they matched and rank by relevance.
    const snippetColumn = SNIPPET_COLUMNS[options.mode];
    if (snippetColumn !== undefined) {
      extra = `, snippet(tracks_fts, ${snippetColumn}, '[', ']', '...', 12) as match`;
      order = 'in_library desc, f.rank';
    }
  } else if (options.mode === 'vibe' || options.mode === 'about-vibe') {
    if (!options.vector) throw new Error('Vibe search needs a query embedding');
    params.vec = options.vector;
    const table = options.mode === 'vibe' ? 'vec_tracks' : 'vec_summaries';
    // Summaries exist only for enriched tracks, few enough to always scan.
    if (options.mode === 'about-vibe' || SMALL_SOURCES.has(options.source)) {
      // A full scan costs ~1 s on the few thousand library tracks and is
      // exact. On the whole index it takes over 10 s, hence KNN below.
      from = `(select track_id, vec_distance_cosine(embedding, $vec) as distance
               from ${table}) v
              join tracks t on t.id = v.track_id`;
    } else {
      // KNN runs before the source filters, so a filtered search fetches
      // the most neighbors sqlite-vec allows and lets the filters trim.
      from = `(select track_id, distance from ${table}
               where embedding match $vec and k = $k) v
              join tracks t on t.id = v.track_id`;
      params.k =
        options.source === 'any' ? Math.min(4096, options.limit * 20) : 4096;
    }
    extra = ', round(v.distance, 4) as distance';
    order = 'v.distance';
  } else if (options.mode === 'artist-vibe') {
    if (!options.vector) throw new Error('Vibe search needs a query embedding');
    params.vec = options.vector;
    params.artists = VIBE_ARTISTS;
    params.per_artist = TRACKS_PER_ARTIST;
    const filters = where.join(' and ');
    const plays =
      '(select count(*) from scrobbles sc where sc.track_id = t.id) desc';
    // With a track vector, each artist contributes the tracks closest to
    // it: an artist that sounds right for "peace" should bring its protest
    // song, not its biggest hit. Without one, the user's most played tracks
    // are the best guess. Distance is cosine, so 2 puts a track without an
    // embedding last; sqlite-vec errors on a null vector instead of
    // returning null, hence the case.
    let trackOrder = plays;
    let trackJoin = '';
    if (options.trackVector) {
      params.track_vec = options.trackVector;
      trackOrder = `case when vt.embedding is null then 2 else vec_distance_cosine(vt.embedding, $track_vec) end, ${plays}`;
      trackJoin = 'left join vec_tracks vt on vt.track_id = t.id';
    }
    // A few thousand artists scan exactly in well under a second. Artists
    // are ranked after the source filters, so one without matching tracks
    // drops out instead of taking a slot.
    from = `(select track_id, distance, n from (
               select ta.track_id, a.distance,
                 row_number() over (partition by a.artist_id order by ${trackOrder}) as n
               from (select v.artist_id, v.distance
                     from (select artist_id, vec_distance_cosine(embedding, $vec) as distance
                           from vec_artists) v
                     where exists (select 1 from track_artists ta
                                   join tracks t on t.id = ta.track_id
                                   where ta.artist_id = v.artist_id and ta.position = 0
                                     and ${filters})
                     order by v.distance, v.artist_id limit $artists) a
               join track_artists ta on ta.artist_id = a.artist_id and ta.position = 0
               join tracks t on t.id = ta.track_id
               ${trackJoin}
               where ${filters})
             where n <= $per_artist) v
            join tracks t on t.id = v.track_id`;
    extra = ', round(v.distance, 4) as distance';
    order = 'v.distance, v.n';
  }

  return db
    .query<RawRow, Record<string, string | number | Float32Array>>(
      `select ${ROW_COLUMNS}${extra} from ${from}
       where ${where.join(' and ')}
       order by ${order} limit $limit`,
    )
    .all(params)
    .map(toRow);
};

export const formatRow = (row: Row) => {
  const meta = [
    row.year,
    row.plays > 0 ? `${row.plays} plays` : null,
    row.explicit ? 'explicit' : null,
    row.vocals ? `${row.vocals} vocals` : null,
    row.sources.join('+') || 'scrobble',
  ]
    .filter(Boolean)
    .join(', ');
  const tags = row.tags.length ? `  [${row.tags.join(', ')}]` : '';
  const about = row.about ? `\n      about: ${row.about}` : '';
  const match = row.match ? `\n      ${row.match.replaceAll('\n', ' / ')}` : '';
  return `${String(row.id).padStart(6)}  ${row.title} - ${row.artists} (${meta})${tags}${about}${match}`;
};
