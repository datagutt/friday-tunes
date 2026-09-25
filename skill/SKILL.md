---
name: friday-tunes
description: Build a playlist for a music theme (the weekly Friday 15:00 theme at work, or any "songs that..." / "X in the title" prompt) from the user's own listening history. Use when the user gives a music theme, asks for songs from their library that match something, or asks to search their Spotify or Last.fm history.
---

# friday-tunes

`ft` searches a local SQLite index of the user's music:
- Liked Songs, own playlists, and Spotify top and recent tracks.
- Last.fm scrobbles since 2008.
- The catalogs of followed and top artists: Last.fm top tracks, plus Spotify discographies that fill in over time.
- Last.fm tags, lyrics and embeddings where a sync has fetched them.

Pick from this index instead of paging through Spotify with MCP tools. The Spotify app is rate limited hard, and a search here takes milliseconds.

## Commands

Always pass `--json` when you read results. Every row has an `id`: the index's own track ID, which `ft playlist create` takes. Rows with a `spotify_url` link straight to Spotify. Rows without one are scrobble or catalog tracks that `ft playlist create` looks up on Spotify.

- `ft search title <words>`: word match in the title. Add `--substring` to match inside words ("love" also finds "lovely").
- `ft search artist <words>`: word match in any artist name on the track.
- `ft search album <words>`, `ft search lyrics <words>`, `ft search tag <words>`: the same match on album, lyrics or Last.fm tags (track and artist tags).
- `ft search year 1996` or `ft search year 1990-1999`: release year. Scrobble-only tracks often have no year.
- `ft search vibe <description>`: semantic search over title, artist, tags and lyrics. Describe the mood in a few words; Norwegian works too.
- Filters for every mode:
  - `--source liked|library|scrobbled|catalog|any`: "library" means liked, own playlists and Spotify top tracks. "catalog" means songs by followed and top artists that the user may not have heard.
  - `--min-plays N`: at least N Last.fm scrobbles.
  - `--limit N`: default 50.
- A trailing `*` on a word is a prefix match. Quote it so the shell does not expand it: `ft search title 'witch*'`.
- `ft stats`: shows what is indexed and how old the sync is. Run it first if results look thin.
- `ft playlist create --name "<name>" --description "<text>" <id> <id> ...`: resolves Spotify IDs for scrobble-only tracks and creates a private playlist. It prints the link and any tracks that are not on Spotify.

A search runs a quick sync first when the index is more than 12 hours old. Its progress goes to stderr. If Spotify or Last.fm is not authorized, the search warns and uses the existing index.

## Workflow

1. Classify the theme. Most themes combine several of these:
   - literal title word ("songs with a color in the title")
   - artist name word ("artists named after animals")
   - lyric subject ("songs about rain")
   - era or year ("songs from the year you were born")
   - genre or mood that tags describe ("dreamy", "witch house", "christmas")
   - open vibe that needs judgment ("songs that evoke magic")
2. Search:
   1. For literal themes, expand the word list before searching. "Color" means red, blue, green, black, white, gold, yellow, purple, pink, grey and gray, and Norwegian words too (rød, blå, grønn, svart, hvit, gul, rosa). The user listens to a lot of Norwegian music.
   2. For vibe themes, run several searches: related title words, lyric words, and tags. Then add songs you know fit the vibe, found through `ft search artist` or `ft search title`.
   3. Search in parallel where you can.
3. Curate:
   - Prefer tracks with `liked` or `playlist` in `sources`, or with many `plays`. The user actually listens to those.
   - Drop weak literal matches whose word only technically fits. Drop duplicate versions of one song.
   - Aim for 30 to 50 tracks unless the user asks for a different size.
   - Group the tracks into 3 to 6 sub-vibes. Order the groups so the playlist flows.
4. Show the grouped list as "Title (Artist)". Name the notable songs you left out and why. Ask before you create anything.
5. After the user approves, run `ft playlist create`. Use the theme as the name, with emojis if the theme had them. Put the theme text and the date in the description. Return the link. Also list the tracks the command reports as not on Spotify.

## When the index is wrong

- If a song the user expects is missing, check `ft stats`. The song may be in a playlist that another user owns: Spotify blocks the contents of those for this app. Songs the user scrobbled on Last.fm are still indexed.
- If Spotify is not authorized, tell the user to run `ft auth`.
- Do not edit the SQLite file directly.
