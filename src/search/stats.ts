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
  const pct = (n: number) =>
    tracks ? `${n} (${Math.round((n / tracks) * 100)}%)` : '0';

  return [
    `tracks:      ${tracks}`,
    `  playable:  ${pct(one(db, 'select count(*) as n from tracks where spotify_id is not null'))}`,
    ...sources.map((s) => `  ${`${s.source}:`.padEnd(10)} ${s.n}`),
    `artists:     ${one(db, 'select count(*) as n from artists')}`,
    `playlists:   ${playlists.map((p) => `${p.n} ${p.status}`).join(', ') || '0'}`,
    `scrobbles:   ${one(db, 'select count(*) as n from scrobbles')}`,
    `tagged:      ${pct(one(db, "select count(distinct entity_id) as n from tags where entity = 'track'"))}`,
    `lyrics:      ${pct(one(db, "select count(*) as n from lyrics where status = 'hit'"))}`,
    `embedded:    ${pct(one(db, 'select count(*) as n from vec_tracks'))}`,
    `quick sync:  ${age(state('sync.quick.at'))}`,
    `full sync:   ${age(state('sync.full.at'))}`,
  ].join('\n');
};
