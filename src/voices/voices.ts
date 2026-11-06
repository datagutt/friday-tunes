import type { Database } from 'bun:sqlite';

export const VOICES = ['female', 'male', 'mixed', 'nonbinary'] as const;
export type Voice = (typeof VOICES)[number];

// What a track's singers add up to. A filter on "female" means no man
// sings, and "mixed" means at least one woman and one man do.
export const VOCALS = ['mixed', 'female', 'male'] as const;
export type Vocals = (typeof VOCALS)[number];

export type VoiceSource = 'manual' | 'wikidata' | 'musicbrainz';

// A manual entry always wins. Wikidata and MusicBrainz both state gender
// outright; Last.fm vocalist tags are listener votes and come last.
const SOURCE_RANK = `case source when 'manual' then 0 when 'wikidata' then 1
  when 'musicbrainz' then 2 else 3 end`;

// Voices rarely change, and an artist missing from a source today is
// unlikely to be added soon.
const VOICE_TTL_SECONDS = 180 * 24 * 3600;

export const saveVoice = (
  db: Database,
  artistId: number,
  source: VoiceSource,
  voice: Voice | null,
) =>
  db
    .query(
      `insert into artist_voices (artist_id, source, voice, fetched_at)
       values (?, ?, ?, unixepoch())
       on conflict do update set voice = excluded.voice, fetched_at = excluded.fetched_at`,
    )
    .run(artistId, source, voice);

export const clearVoice = (
  db: Database,
  artistId: number,
  source: VoiceSource,
) =>
  db
    .query('delete from artist_voices where artist_id = ? and source = ?')
    .run(artistId, source);

export interface PendingArtist {
  readonly id: number;
  readonly name: string;
  readonly spotify_id: string | null;
  readonly genius_id: number | null;
}

// Artists the user listens to most go first, so a cut-short run already
// covers the ones themes pick. `where` narrows the queue per source, such
// as artists a source can look up at all.
export const pendingVoices = (
  db: Database,
  source: VoiceSource,
  where: string,
) =>
  db
    .query<PendingArtist, [string, number]>(
      `select a.id, a.name, a.spotify_id, a.genius_id from artists a
       left join artist_voices v on v.artist_id = a.id and v.source = ?
       where (v.artist_id is null or v.fetched_at < ?) and (${where})
       order by a.lastfm_rank is null, a.lastfm_rank, a.followed desc,
         not exists (select 1 from track_artists ta join track_sources s
                     on s.track_id = ta.track_id
                     where ta.artist_id = a.id
                       and s.source in ('liked', 'playlist', 'top')),
         a.id`,
    )
    .all(source, Math.floor(Date.now() / 1000) - VOICE_TTL_SECONDS);

// Combines the voices of several people into one: a band whose singers
// are a woman and a man is mixed.
export const combineVoices = (
  voices: ReadonlyArray<Voice | null>,
): Voice | null => {
  const female = voices.some((v) => v === 'female' || v === 'mixed');
  const male = voices.some((v) => v === 'male' || v === 'mixed');
  if (female && male) return 'mixed';
  if (female) return 'female';
  if (male) return 'male';
  return voices.includes('nonbinary') ? 'nonbinary' : null;
};

const LASTFM_FEMALE = "lower(g.tag) like '%female vocal%'";
const LASTFM_MALE =
  "lower(g.tag) in ('male vocalists', 'male vocalist', 'male vocals')";

// Derives artists.voice from the best source, then tracks.vocals from the
// singers: Genius singers plus every Spotify artist Genius does not name
// as credited without singing. Runs
// after every sync and manual change; on the full index it takes well
// under a second.
export const rebuildVoices = (db: Database) =>
  db
    .transaction(() => {
      db.run(`
        update artists set voice = (
          select voice from (
            select source, voice from artist_voices v
            where v.artist_id = artists.id and v.voice is not null
            union all
            -- Tags for both sexes say nothing about a solo artist, so
            -- Last.fm counts only when the tags agree.
            select 'lastfm' as source,
              case when max(${LASTFM_FEMALE}) = 1 and max(${LASTFM_MALE}) = 0 then 'female'
                   when max(${LASTFM_MALE}) = 1 and max(${LASTFM_FEMALE}) = 0 then 'male' end
            from tags g
            where g.entity = 'artist' and g.entity_id = artists.id
              and (${LASTFM_FEMALE} or ${LASTFM_MALE})
          )
          where voice is not null
          order by ${SOURCE_RANK} limit 1)`);
      db.run(`
        update tracks set vocals = (
          select case
            when max(a.voice in ('female', 'mixed')) = 1
              and max(a.voice in ('male', 'mixed')) = 1 then 'mixed'
            when max(a.voice in ('female', 'mixed')) = 1 then 'female'
            when max(a.voice in ('male', 'mixed')) = 1 then 'male' end
          from artists a
          where a.voice is not null and a.id in (
            select c.artist_id from track_credits c
            where c.track_id = tracks.id and c.sings = 1
            union
            select ta.artist_id from track_artists ta
            where ta.track_id = tracks.id and not exists (
              select 1 from track_credits c where c.track_id = tracks.id
                and c.artist_id = ta.artist_id and c.sings = 0)))`);
    })
    .immediate();
