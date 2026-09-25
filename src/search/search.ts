import type { Database } from 'bun:sqlite';
import { normalizeTitle } from '../normalize';

export const MODES = [
  'title',
  'artist',
  'album',
  'lyrics',
  'tag',
  'year',
  'vibe',
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
  /** Query embedding; required for vibe mode. */
  readonly vector?: Float32Array;
}

export interface Row {
  readonly id: number;
  readonly title: string;
  readonly artists: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly spotify_id: string | null;
  readonly spotify_url: string | null;
  readonly plays: number;
  readonly sources: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
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

const FTS_COLUMN: Partial<Record<Mode, string>> = {
  title: 'title',
  artist: 'artists',
  album: 'album',
  lyrics: 'lyrics',
  tag: 'tags',
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

const parseYears = (query: string): [number, number] => {
  const match = query.trim().match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);
  if (!match?.[1])
    throw new Error('Year query must look like 1996 or 1990-1999');
  return [Number(match[1]), Number(match[2] ?? match[1])];
};

const ROW_COLUMNS = `
  t.id, t.title, t.album, t.release_year as year, t.spotify_id,
  (select group_concat(name, ', ') from (
    select a.name from track_artists ta join artists a on a.id = ta.artist_id
    where ta.track_id = t.id order by ta.position)) as artists,
  (select count(*) from scrobbles sc where sc.track_id = t.id) as plays,
  (select group_concat(distinct source) from track_sources s where s.track_id = t.id) as sources,
  (select group_concat(tag, ', ') from (
    select tag from tags where entity = 'track' and entity_id = t.id
    order by weight desc limit 5)) as tags,
  exists (select 1 from track_sources s where s.track_id = t.id and s.source in ${LIBRARY_SOURCES}) as in_library`;

interface RawRow extends Omit<Row, 'sources' | 'tags' | 'spotify_url'> {
  sources: string | null;
  tags: string | null;
  in_library: number;
}

const toRow = ({
  in_library: _,
  sources,
  tags,
  match,
  ...rest
}: RawRow): Row => ({
  ...rest,
  artists: rest.artists ?? '',
  spotify_url: rest.spotify_id
    ? `https://open.spotify.com/track/${rest.spotify_id}`
    : null,
  sources: sources ? sources.split(',') : [],
  tags: tags ? tags.split(', ') : [],
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

  let from = 'tracks t';
  let extra = '';
  let order = 'in_library desc, plays desc';
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
    if (options.mode === 'lyrics') {
      extra = ", snippet(tracks_fts, 4, '[', ']', '...', 12) as match";
      order = 'in_library desc, f.rank';
    }
  } else if (options.mode === 'vibe') {
    if (!options.vector) throw new Error('Vibe search needs a query embedding');
    // KNN runs before the source filters, so fetch extra neighbors for the
    // filters to trim. sqlite-vec caps k at 4096.
    from = `(select track_id, distance from vec_tracks
             where embedding match $vec and k = $k) v
            join tracks t on t.id = v.track_id`;
    params.vec = options.vector;
    params.k = Math.min(4096, options.limit * 20);
    extra = ', round(v.distance, 4) as distance';
    order = 'v.distance';
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
    row.sources.join('+') || 'scrobble',
  ]
    .filter(Boolean)
    .join(', ');
  const tags = row.tags.length ? `  [${row.tags.join(', ')}]` : '';
  const match = row.match ? `\n      ${row.match.replaceAll('\n', ' / ')}` : '';
  return `${String(row.id).padStart(6)}  ${row.title} - ${row.artists} (${meta})${tags}${match}`;
};
