import type { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { Db } from '../db/db';
import { getState, setState, upsertArtist, upsertTrack } from '../db/library';
import { LastFm } from './client';
import { RecentTracks, type Scrobble, TopArtists, TopTags } from './schema';

const PAGE_SIZE = 200;
const TOP_ARTISTS = 200;

// Tags are re-fetched after this long; community tags change slowly.
const TAGS_TTL_SECONDS = 180 * 24 * 3600;
// Tags keep this many per entity, and drop the long tail of one-off tags.
const MAX_TAGS = 15;
const MIN_TAG_WEIGHT = 5;
// Scrobble-only tracks with fewer plays than this are not worth a tag call.
export const MIN_PLAYS_FOR_ENRICHMENT = 3;

const writeScrobbles = (db: Database, scrobbles: ReadonlyArray<Scrobble>) => {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  db.transaction(() => {
    const insert = db.query(
      'insert or ignore into scrobbles (played_at, track_id) values (?, ?)',
    );
    for (const s of scrobbles) {
      // The currently playing track has no timestamp and is not a scrobble yet.
      if (!s.date || s['@attr']?.nowplaying === 'true') continue;
      if (!s.artist['#text'] || !s.name) continue;
      const trackId = upsertTrack(db, {
        title: s.name,
        artists: [{ name: s.artist['#text'] }],
        album: s.album?.['#text'] || null,
      });
      insert.run(s.date.uts, trackId);
      oldest = Math.min(oldest, s.date.uts);
      newest = Math.max(newest, s.date.uts);
    }
  })();
  return { oldest, newest };
};

const fetchPage = (params: { from?: number; to?: number }, page: number) =>
  Effect.gen(function* () {
    const lastfm = yield* LastFm;
    return yield* lastfm.call(RecentTracks, 'user.getrecenttracks', {
      user: lastfm.user,
      limit: PAGE_SIZE,
      page,
      ...params,
    });
  });

// New scrobbles since the stored cursor. The cursor moves only after every
// page is written, so an interrupted run re-reads instead of leaving a gap.
const syncNewScrobbles = Effect.gen(function* () {
  const db = yield* Db;
  const latest = Number(getState(db, 'lastfm.scrobbles.latest'));
  let newest = latest;
  let count = 0;
  for (let page = 1, pages = 1; page <= pages; page++) {
    const result = yield* fetchPage({ from: latest + 1 }, page);
    pages = result.recenttracks['@attr'].totalPages;
    const written = writeScrobbles(db, result.recenttracks.track);
    newest = Math.max(newest, written.newest);
    count += result.recenttracks.track.length;
  }
  setState(db, 'lastfm.scrobbles.latest', newest);
  return count;
});

// The first run walks back through the whole history, 200 scrobbles per
// call. The backfill cursor moves after every page, so an interrupted
// backfill resumes where it stopped.
const backfillScrobbles = Effect.gen(function* () {
  const db = yield* Db;
  const cursor = Number(
    getState(db, 'lastfm.backfill.before') ?? Math.floor(Date.now() / 1000),
  );
  if (getState(db, 'lastfm.scrobbles.latest') === undefined) {
    setState(db, 'lastfm.scrobbles.latest', cursor);
  }
  for (let page = 1, pages = 1; page <= pages; page++) {
    const result = yield* fetchPage({ to: cursor }, page);
    const attr = result.recenttracks['@attr'];
    pages = attr.totalPages;
    const written = writeScrobbles(db, result.recenttracks.track);
    if (Number.isFinite(written.oldest)) {
      setState(db, 'lastfm.backfill.before', written.oldest);
    }
    if (page % 25 === 0 || page === pages) {
      yield* Effect.logInfo(
        `scrobble backfill: page ${page}/${pages} (${attr.total} scrobbles)`,
      );
    }
  }
  setState(db, 'lastfm.backfill.done', 1);
});

export const syncScrobbles = Effect.gen(function* () {
  const db = yield* Db;
  if (getState(db, 'lastfm.backfill.done') !== '1') {
    yield* backfillScrobbles;
  }
  const count = yield* syncNewScrobbles;
  yield* Effect.logInfo(`scrobbles: ${count} new`);
});

export const syncTopArtists = Effect.gen(function* () {
  const db = yield* Db;
  const lastfm = yield* LastFm;
  const result = yield* lastfm.call(TopArtists, 'user.gettopartists', {
    user: lastfm.user,
    period: 'overall',
    limit: TOP_ARTISTS,
  });
  db.transaction(() => {
    db.run('update artists set lastfm_playcount = null, lastfm_rank = null');
    const update = db.query(
      'update artists set lastfm_playcount = ?, lastfm_rank = ? where id = ?',
    );
    for (const artist of result.topartists.artist) {
      update.run(
        artist.playcount,
        artist['@attr'].rank,
        upsertArtist(db, { name: artist.name }),
      );
    }
  })();
  yield* Effect.logInfo(
    `last.fm top artists: ${result.topartists.artist.length}`,
  );
});

const fetchTags = (
  method: 'track.gettoptags' | 'artist.gettoptags',
  params: Record<string, string>,
) =>
  Effect.flatMap(LastFm, (lastfm) =>
    lastfm.call(TopTags, method, { ...params, autocorrect: 1 }),
  ).pipe(
    Effect.map((r) =>
      r.toptags.tag
        .filter((t) => t.count >= MIN_TAG_WEIGHT)
        .slice(0, MAX_TAGS)
        .map((t) => ({ tag: t.name.toLowerCase().trim(), weight: t.count })),
    ),
    Effect.catchTag('LastFmNotFound', () => Effect.succeed([])),
  );

const saveTags = (
  db: Database,
  entity: 'track' | 'artist',
  id: number,
  tags: ReadonlyArray<{ tag: string; weight: number }>,
) =>
  db.transaction(() => {
    db.query('delete from tags where entity = ? and entity_id = ?').run(
      entity,
      id,
    );
    const insert = db.query(
      'insert or ignore into tags (entity, entity_id, tag, weight) values (?, ?, ?, ?)',
    );
    for (const t of tags) insert.run(entity, id, t.tag, t.weight);
    db.query(
      `update ${entity === 'track' ? 'tracks' : 'artists'} set tags_fetched_at = unixepoch() where id = ?`,
    ).run(id);
  })();

// Library and often-scrobbled tracks: the ones a theme is likely to pick.
// Catalog-only tracks are skipped because there are too many of them for
// one call each; they still match through their artist's tags.
export const ENRICH_TRACKS = `
  exists (select 1 from track_sources s where s.track_id = t.id
          and s.source in ('liked', 'playlist', 'top', 'recent'))
  or (select count(*) from scrobbles sc where sc.track_id = t.id) >= ${MIN_PLAYS_FOR_ENRICHMENT}`;

export const syncTags = Effect.gen(function* () {
  const db = yield* Db;
  const staleBefore = Math.floor(Date.now() / 1000) - TAGS_TTL_SECONDS;

  const artists = db
    .query<{ id: number; name: string }, [number]>(
      `select a.id, a.name from artists a
       where coalesce(a.tags_fetched_at, 0) < ?
         and (a.followed = 1 or a.lastfm_rank is not null
           or exists (select 1 from track_artists ta join tracks t on t.id = ta.track_id
                      where ta.artist_id = a.id and (${ENRICH_TRACKS})))`,
    )
    .all(staleBefore);
  yield* Effect.logInfo(`tags: ${artists.length} artists to fetch`);
  for (const [i, artist] of artists.entries()) {
    const tags = yield* fetchTags('artist.gettoptags', { artist: artist.name });
    saveTags(db, 'artist', artist.id, tags);
    if ((i + 1) % 250 === 0) {
      yield* Effect.logInfo(`tags: ${i + 1}/${artists.length} artists`);
    }
  }

  const tracks = db
    .query<{ id: number; title: string; artist: string }, [number]>(
      `select t.id, t.title,
         (select a.name from track_artists ta join artists a on a.id = ta.artist_id
          where ta.track_id = t.id order by ta.position limit 1) as artist
       from tracks t
       where coalesce(t.tags_fetched_at, 0) < ? and (${ENRICH_TRACKS})`,
    )
    .all(staleBefore);
  yield* Effect.logInfo(`tags: ${tracks.length} tracks to fetch`);
  for (const [i, track] of tracks.entries()) {
    const tags = yield* fetchTags('track.gettoptags', {
      artist: track.artist,
      track: track.title,
    });
    saveTags(db, 'track', track.id, tags);
    if ((i + 1) % 500 === 0) {
      yield* Effect.logInfo(`tags: ${i + 1}/${tracks.length} tracks`);
    }
  }
});
