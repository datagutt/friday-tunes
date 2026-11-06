import type { Database } from 'bun:sqlite';
import { normalizeArtist } from '../normalize';
import { clearVoice, rebuildVoices, saveVoice, type Voice } from './voices';

// One name can belong to several rows: an artist first seen on Last.fm and
// the same artist credited on Genius. A manual voice applies to all of them.
const artistsNamed = (db: Database, name: string) =>
  db
    .query<{ id: number; name: string; voice: string | null }, [string]>(
      'select id, name, voice from artists where name_norm = ? order by id',
    )
    .all(normalizeArtist(name));

export const showVoice = (db: Database, name: string) => {
  const artists = artistsNamed(db, name);
  if (artists.length === 0) return `No artist named "${name}" in the index.`;
  const sources = db.query<{ source: string; voice: string | null }, [number]>(
    'select source, voice from artist_voices where artist_id = ? order by source',
  );
  return artists
    .map((a) => {
      const found = sources
        .all(a.id)
        .map((s) => `${s.source}: ${s.voice ?? 'not found'}`)
        .join(', ');
      return `${a.name} (${a.id}): ${a.voice ?? 'unknown'}${found ? `  [${found}]` : ''}`;
    })
    .join('\n');
};

export const setManualVoice = (
  db: Database,
  name: string,
  voice: Voice | null,
) => {
  const artists = artistsNamed(db, name);
  if (artists.length === 0) return `No artist named "${name}" in the index.`;
  for (const artist of artists) {
    if (voice) saveVoice(db, artist.id, 'manual', voice);
    else clearVoice(db, artist.id, 'manual');
  }
  rebuildVoices(db);
  return showVoice(db, name);
};
