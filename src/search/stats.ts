import type { Database } from 'bun:sqlite';

const one = (db: Database, sql: string) =>
  db.query<{ n: number }, []>(sql).get()?.n ?? 0;

const age = (epochSeconds: string | undefined) => {
  if (!epochSeconds) return 'never';
  const hours = (Date.now() / 1000 - Number(epochSeconds)) / 3600;
  return hours < 48
    ? `${hours.toFixed(1)} h ago`
    : `${(hours / 24).toFixed(1)} days ago`;
};

export const stats = (db: Database) => {
  const state = (key: string) =>
    db
      .query<{ value: string }, [string]>(
        'select value from sync_state where key = ?',
      )
      .get(key)?.value;
  const sources = db
    .query<{ source: string; n: number }, []>(
      'select source, count(distinct track_id) as n from track_sources group by source order by n desc',
    )
    .all();
  const playlists = db
    .query<{ status: string; n: number }, []>(
      'select status, count(*) as n from playlists group by status',
    )
    .all();
  const tracks = one(db, 'select count(*) as n from tracks');
  const artists = one(db, 'select count(*) as n from artists');
  const share = (total: number) => (n: number) =>
    total ? `${n} (${Math.round((n / total) * 100)}%)` : '0';
  const pct = share(tracks);
  const artistPct = share(artists);

  return [
    `tracks:      ${tracks}`,
    `  playable:  ${pct(one(db, 'select count(*) as n from tracks where spotify_id is not null'))}`,
    ...sources.map((s) => `  ${`${s.source}:`.padEnd(10)} ${s.n}`),
    `artists:     ${artists}`,
    `playlists:   ${playlists.map((p) => `${p.n} ${p.status}`).join(', ') || '0'}`,
    `scrobbles:   ${one(db, 'select count(*) as n from scrobbles')}`,
    // Last.fm has track tags for few songs; tag searches mostly match
    // through the artist's tags, which is the number that matters.
    `tagged:      ${pct(one(db, "select count(*) as n from tracks t where exists (select 1 from track_artists ta join tags g on g.entity = 'artist' and g.entity_id = ta.artist_id where ta.track_id = t.id)"))} via artist, ${pct(one(db, "select count(distinct entity_id) as n from tags where entity = 'track'"))} own`,
    `explicit known: ${pct(one(db, 'select count(*) as n from tracks where explicit is not null'))}`,
    `lyrics:      ${pct(one(db, "select count(*) as n from lyrics where status = 'hit'"))}`,
    `summaries:   ${pct(one(db, "select count(*) as n from summaries where status = 'hit'"))}`,
    `embedded:    ${pct(one(db, 'select count(*) as n from vec_tracks'))}`,
    `artist bios: ${artistPct(one(db, "select count(*) as n from artist_bios where source = 'lastfm' and bio is not null"))} last.fm, ${artistPct(one(db, "select count(*) as n from artist_bios where source = 'genius' and bio is not null"))} genius`,
    `artists embedded: ${artistPct(one(db, 'select count(*) as n from vec_artists'))}`,
    `artist voices: ${artistPct(one(db, 'select count(*) as n from artists where voice is not null'))}`,
    `singers:     ${pct(one(db, 'select count(distinct track_id) as n from track_singers'))} from Genius credits, ${pct(one(db, "select count(*) as n from genius where status = 'hit' and credits_at is null"))} still to fetch`,
    `vocals known: ${pct(one(db, 'select count(*) as n from tracks where vocals is not null'))}, ${one(db, "select count(*) as n from tracks where vocals = 'mixed'")} mixed`,
    `quick sync:  ${age(state('sync.quick.at'))}`,
    `full sync:   ${age(state('sync.full.at'))}`,
  ].join('\n');
};
