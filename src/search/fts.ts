import type { Database } from 'bun:sqlite';

// A full rebuild takes a few seconds even with lyrics, which is cheaper to
// keep correct than per-row triggers across five source tables.
export const rebuildFts = (db: Database) =>
  db.transaction(() => {
    db.run('delete from tracks_fts');
    db.run(`
      insert into tracks_fts (rowid, title, artists, album, tags, lyrics)
      select
        t.id,
        t.title,
        (select group_concat(name, ' | ') from (
          select a.name from track_artists ta join artists a on a.id = ta.artist_id
          where ta.track_id = t.id order by ta.position)),
        t.album,
        (select group_concat(tag, ' | ') from (
          select tag from tags where entity = 'track' and entity_id = t.id
          union
          select g.tag from tags g join track_artists ta
            on g.entity = 'artist' and g.entity_id = ta.artist_id
          where ta.track_id = t.id)),
        l.plain
      from tracks t left join lyrics l on l.track_id = t.id
    `);
  })();
