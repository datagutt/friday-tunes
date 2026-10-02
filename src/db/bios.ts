import type { Database } from 'bun:sqlite';

export type BioSource = 'lastfm' | 'genius';

// Bios change rarely, and a missing one is unlikely to appear soon.
const BIO_TTL_SECONDS = 180 * 24 * 3600;

export const saveBio = (
  db: Database,
  artistId: number,
  source: BioSource,
  bio: string | null,
) =>
  db
    .query(
      `insert into artist_bios (artist_id, source, bio, fetched_at)
       values (?, ?, ?, unixepoch())
       on conflict do update set bio = excluded.bio, fetched_at = excluded.fetched_at`,
    )
    .run(artistId, source, bio);

// Artists the user listens to most go first, so a cut-short run already
// covers the ones themes pick.
export const pendingBios = (db: Database, source: BioSource) =>
  db
    .query<{ id: number; name: string }, [string, number]>(
      `select a.id, a.name from artists a
       left join artist_bios b on b.artist_id = a.id and b.source = ?
       where b.artist_id is null or b.fetched_at < ?
       order by a.lastfm_rank is null, a.lastfm_rank, a.followed desc,
         not exists (select 1 from track_artists ta join track_sources s
                     on s.track_id = ta.track_id
                     where ta.artist_id = a.id
                       and s.source in ('liked', 'playlist', 'top')),
         a.id`,
    )
    .all(source, Math.floor(Date.now() / 1000) - BIO_TTL_SECONDS);
