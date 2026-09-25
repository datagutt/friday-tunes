import { Effect } from 'effect';
import { Db } from '../db/db';
import { normalizeArtist, normalizeTitle } from '../normalize';
import { Spotify } from './client';
import { SearchTracks, type Track } from './schema';

// A miss is retried after this long, since Spotify adds catalog over time.
const MISS_RETRY_SECONDS = 30 * 24 * 3600;

interface Unresolved {
  readonly id: number;
  readonly title: string;
  readonly artist: string;
  readonly duration_ms: number | null;
}

// Title and primary artist must match after normalization. Duration only
// breaks ties, because Last.fm often has no duration.
export const pickCandidate = (
  track: Unresolved,
  candidates: ReadonlyArray<Track | null>,
) => {
  const title = normalizeTitle(track.title);
  const artist = normalizeArtist(track.artist);
  return candidates
    .filter(
      (c): c is Track & { id: string } =>
        c?.id != null &&
        normalizeTitle(c.name) === title &&
        c.artists.some((a) => normalizeArtist(a.name) === artist),
    )
    .map((c) => ({
      candidate: c,
      distance:
        track.duration_ms === null
          ? 0
          : Math.abs(c.duration_ms - track.duration_ms),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.candidate;
};

const quote = (value: string) => `"${value.replaceAll('"', ' ')}"`;

export const resolveTracks = (trackIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const spotify = yield* Spotify;
    const resolved = new Map<number, string | null>();
    const now = Math.floor(Date.now() / 1000);

    for (const id of trackIds) {
      const row = db
        .query<
          Unresolved & {
            spotify_id: string | null;
            resolve_status: string | null;
            resolved_at: number | null;
          },
          [number]
        >(
          `select t.id, t.title, t.duration_ms, t.spotify_id, t.resolve_status, t.resolved_at,
             (select a.name from track_artists ta join artists a on a.id = ta.artist_id
              where ta.track_id = t.id order by ta.position limit 1) as artist
           from tracks t where t.id = ?`,
        )
        .get(id);
      if (!row) {
        resolved.set(id, null);
        continue;
      }
      if (row.spotify_id) {
        resolved.set(id, row.spotify_id);
        continue;
      }
      if (
        row.resolve_status === 'miss' &&
        now - (row.resolved_at ?? 0) < MISS_RETRY_SECONDS
      ) {
        resolved.set(id, null);
        continue;
      }

      const results = yield* spotify.get(SearchTracks, 'search', {
        q: `track:${quote(row.title)} artist:${quote(row.artist)}`,
        type: 'track',
        limit: 10,
      });
      const match = pickCandidate(row, results.tracks.items);
      db.transaction(() => {
        if (match) {
          db.query(
            `update tracks set spotify_id = ?, duration_ms = coalesce(duration_ms, ?),
               resolve_status = 'hit', resolved_at = ? where id = ?`,
          ).run(match.id, match.duration_ms, now, id);
          db.query(
            'insert or ignore into track_spotify_ids (spotify_id, track_id) values (?, ?)',
          ).run(match.id, id);
        } else {
          db.query(
            "update tracks set resolve_status = 'miss', resolved_at = ? where id = ?",
          ).run(now, id);
        }
      })();
      resolved.set(id, match?.id ?? null);
    }
    return resolved;
  });
