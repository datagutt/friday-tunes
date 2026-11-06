---
name: friday-tunes
description: Build a playlist for a music theme (the weekly Friday 15:00 theme at work, or any "songs that..." / "X in the title" prompt) from the user's own listening history. Use when the user gives a music theme, asks for songs from their library that match something, or asks to search their Spotify or Last.fm history.
---

# friday-tunes

`ft` searches a local SQLite index of the user's music:
- Liked Songs, own playlists, and Spotify top and recent tracks.
- Last.fm scrobbles since 2008.
- The catalogs of followed and top artists: Last.fm top tracks, plus Spotify discographies that fill in over time.
- Voices: who sings on each song (Genius credits) and whether each artist sings as a woman, a man or a band with both (Wikidata, MusicBrainz, Last.fm tags, manual entries).
- Last.fm tags, lyrics, Genius notes (a song's About text and listener annotations) and track embeddings, where a sync has fetched them.
- Summaries: a short account of what each song is about and the playlist themes it fits, written by a local model for songs with lyrics or Genius notes. A row shows it as `about`.
- Artist embeddings built from each artist's Last.fm tags.

Pick from this index instead of paging through Spotify with MCP tools. The Spotify app is rate limited hard, and a search here takes milliseconds.

## Commands

Read the default text output: a short block per track. It starts with the index's own track ID, which the `ft playlist` commands take, then what the song is about and why it matched. It is compact enough to read whole. Pass `--json` only when you need a field the text leaves out, such as `spotify_url`. Tracks without a Spotify ID are scrobble or catalog tracks that the `ft playlist` commands look up on Spotify.

- `ft theme --vibe "<mood>" --sound "<genres and sound>" --avoid "<neighbouring theme>" --word <w> --word <w> --tag <t> --exclude-tag <t>`: the main tool for open themes. It fuses these searches into one ranked list:
  - `vibe`: the mood against track embeddings.
  - `about-vibe`: the vibe against summary embeddings. This finds songs by what they are about, even when no theme word is in the title or lyrics.
  - `artist-vibe`: the sound against artist embeddings, then the tracks of each matching artist that sit closest to the vibe. This finds the artists that fit a theme, so you do not have to guess them. It runs only when you pass `--sound`.
  - One search per word across title, lyrics, Genius notes and summaries. The fields count as one signal, so a common word cannot outvote the vibe.
  - One search per tag.
  `--avoid` drops tracks that sit closer to another theme than to the vibe. Embeddings put holidays, seasons and moods close together, so a Halloween vibe also finds Christmas songs that mention ghost stories; `--avoid "christmas"` removes them. Use it for the theme's nearest neighbour (Halloween and Christmas, summer and spring, love and breakup), not as a general filter. It needs `--vibe`.
  Each row lists the searches that found it in `signals` (`via` in text), and `score` rises when several agree. A small boost for plays and likes tips close calls toward songs the user knows. Covers and other versions of the same song are listed under the best ranked one as `versions` (`also` in text), so each song takes one place. Words accept a trailing `*`. One `ft theme` call with many `--word`s replaces a loop of `ft search title` calls.
- `ft search title <words>`: word match in the title. Add `--substring` to match inside words ("love" also finds "lovely").
- `ft search artist <words>`: word match in any artist name on the track. Results come most played first, so `ft search artist ramones --limit 10` lists the songs the user knows best by that artist.
- `ft search album <words>`, `ft search lyrics <words>`, `ft search tag <words>`: the same match on album, lyrics or Last.fm tags. Almost every track carries its artists' tags, but few have tags of their own, so a tag search finds genres ("post-punk", "dream pop") and rarely occasions ("halloween").
- `ft search meaning <words>`: match in the Genius About text and annotations. Use it for themes about what a song means or where it comes from ("songs about a real event", "songs written for someone"). The `match` field shows the matching passage.
- `ft search about <words>`: word match in the summaries and their themes. Summaries are in English, whatever the language of the song.
- `ft search about-vibe <description>`: semantic search over the summaries. Describe the subject ("songs about war photographers", "protest songs against the Vietnam war").
- `ft search year 1996` or `ft search year 1990-1999`: release year. Scrobble-only tracks often have no year.
- `ft search vibe <description>`: semantic search over each track's title, artist, tags, lyrics and Genius notes. Describe the mood in a few words; Norwegian works too.
- `ft search artist-vibe <sound>`: semantic search over artists, returning up to 4 of each matching artist's most played tracks. Describe genres, instruments and regions ("indie folk, acoustic, nordic folk"). Moods and seasons ("autumn", "cozy") match poorly, because tags rarely name them.
- Filters for every mode:
  - `--source liked|library|scrobbled|catalog|any`: defaults to `any`, and that is right for themes. "library" means liked, own playlists and Spotify top tracks; it hides the Last.fm history, which is where most songs the user knows live. "catalog" means songs by followed and top artists that the user may not have heard. The ranking already prefers played and liked songs over catalog ones.
  - `--min-plays N`: at least N Last.fm scrobbles.
  - `--limit N`: default 50.
  - `--vocals mixed|female|male`: only songs where a woman and a man both sing, or only women, or only men. Rows show `mixed vocals` and so on when the voices are known. Songs with unknown singers are left out, so a filtered search misses some fitting songs; see "When the index is wrong".
  - `--clean`: leave out songs Spotify marks explicit. Only when the user asks for it: Spotify's flag mostly marks swearing, which is fine at this workplace. Rows show `explicit` when Spotify says so.
  - `--exclude-tag <t>`: leave out tracks whose own or artist tags contain this phrase. Repeat for several. "metal" also drops "heavy metal" and "power metal". It is blunt: one stray tag drops an artist entirely (Guns N' Roses carries a metal tag), so use it only for genres that would clearly break the mood, and check what it removed.
- A trailing `*` on a word is a prefix match. Quote it so the shell does not expand it: `ft search title 'witch*'`.
- `ft voice "<artist>"` shows an artist's voice and where it came from. `ft voice "<artist>" female|male|mixed|nonbinary` sets it by hand, and `clear` removes the manual entry. Set it when the user tells you who sings, so the next search knows.
- `ft stats`: shows what is indexed and how old the sync is. Run it first if results look thin.
- `ft playlist create --name "<name>" --description "<text>" <id> <id> ...`: resolves Spotify IDs for scrobble-only tracks and creates a private playlist. It prints the link and any tracks that are not on Spotify.
- `ft playlist add <link> <id> ...` and `ft playlist remove <link> <id> ...`: change an existing playlist. The link can be a URL, URI or bare ID. Use these when the user asks for more or fewer songs, instead of creating a new playlist.
- For a track that is not on Spotify, the playlist commands list other indexed versions of the same song (`other versions: Creedence Clearwater Revival (28607)`). Offer one of those as a replacement.

A search runs a quick sync first when the index is more than 12 hours old. Its progress goes to stderr. If Spotify or Last.fm is not authorized, the search warns and uses the existing index.

## Workflow

0. A Friday theme is a thread where coworkers post songs. If the user names songs that are already posted, leave them out of everything you propose.
1. Classify the theme. Most themes combine several of these:
   - literal title word ("songs with a color in the title")
   - artist name word ("artists named after animals")
   - lyric subject ("songs about rain")
   - era or year ("songs from the year you were born")
   - who performs ("duets with male and female vocals", "female fronted bands"): a fact about the singers, not about the song's text. Use `--vocals`, not title or lyric words
   - genre or mood that tags describe ("dreamy", "witch house", "christmas")
   - open vibe that needs judgment ("songs that evoke magic")
2. Expand the theme before you search. Themes are often puns or references, so write out what they could point to: people, places, events, band names and wordplay. "(Nobel) Peace (Prize)" points to Oslo, Dylan, Mandela, Gorbachev, a band called War, songs about peace and war, and the Norwegian "fred". Each becomes a `--word`, an artist search or part of the `--vibe`.
3. Search:
   1. For literal themes, expand the word list before searching. "Color" means red, blue, green, black, white, gold, yellow, purple, pink, grey and gray, and Norwegian words too (rød, blå, grønn, svart, hvit, gul, rosa). The user listens to a lot of Norwegian music.
   2. For vibe themes, run `ft theme` with all of these:
      - `--vibe`: the subject and mood in a sentence ("anti-war songs, protest against war and nuclear weapons"). It searches both the track embeddings and the summaries.
      - `--sound`: translate the theme into how it sounds, as genres, instruments and regions. "Autumn" becomes "indie folk, acoustic, singer-songwriter, chamber folk, nordic folk, dream pop". This is how the search finds the right artists. Do not search artist names one by one to cover them.
      - 5 to 10 related `--word`s, in English and Norwegian. Avoid month and weekday names unless the theme is about them: Genius notes are full of release dates. Norwegian words also match English text ("fred" finds Genius notes about someone named Fred), so check why a Norwegian word matched.
      - `--avoid` for the theme's nearest neighbour, when there is one (Halloween and Christmas).
      - `--exclude-tag` for genres that would clearly break the mood, if any.
      - Tags only as extra hints.
   3. If the sound covers several styles, run `ft search artist-vibe` once per style as well (for autumn: "nordic folk", "dream pop", "slowcore"), so one style does not crowd out the others.
   4. Treat every signal as a hint, never as proof:
      - Tags are noisy, and artist tags say nothing about a single song.
      - Lyrics and Genius notes cover most of the library, but a word in a lyric can be in passing.
      - Title words are literal ("Must Be Nice" matched "fairy tale" in its lyrics).
      - The track vibe search leans toward title words.
      - `artist-vibe` finds artists by genre, so a fitting artist can still bring tracks that miss the theme. Check them.
      A track that several signals agree on is a strong candidate. A track with one weak signal needs your own judgment.
   5. Fill in from what you know. The signals miss songs whose fit is cultural rather than textual: a film's theme song (Pet Sematary), a song a famous scene used (The Killing Moon in Donnie Darko), a song everyone links to the occasion (Bad Moon Rising for werewolves). List the classics for the theme and check each with `ft search title`, and check artists the user plays a lot whose work fits with `ft search artist <name> --limit 10`. Keep the songs the user has plays on. If you find yourself adding many artists by hand for their sound, the `--sound` description is too narrow: rewrite it and search again.
   6. Search in parallel where you can.
4. Curate:
   - Judge every candidate against the theme yourself, from what you know about the song and its `match` passage. A signal only says where to look.
   - Prefer tracks with `liked` or `playlist` in `sources`, or with many `plays`. The user actually listens to those.
   - The playlist is played at work. Swearing is fine there, so do not drop songs for explicit language. Leave out songs whose content is extreme (graphic sexual lyrics, glorified violence) and say which ones you left out, so the user can overrule you.
   - Drop weak literal matches whose word only technically fits. When a song has `versions`, pick the one the user plays or keeps in the library.
   - Aim for 30 to 50 tracks unless the user asks for a different size.
   - Group the tracks into 3 to 6 sub-vibes. Order the groups so the playlist flows.
5. Show the grouped list as "Title (Artist)". Name the notable songs you left out and why. Ask before you create anything.
6. After the user approves, run `ft playlist create`. Use the theme as the name, with emojis if the theme had them. Put the theme text and the date in the description. Return the link. Also list the tracks the command reports as not on Spotify, with the other versions it suggests.
7. Later changes go through `ft playlist add` and `ft playlist remove` on the same link.

## When the index is wrong

- If a song the user expects is missing, check `ft stats`. A song without a summary is invisible to `about-vibe`; the summary step writes about 230 per hourly run, and the run only happens while the Mac is awake. The song may be in a playlist that another user owns: Spotify blocks the contents of those for this app. Songs the user scrobbled on Last.fm are still indexed.
- If a `--vocals` search misses songs, their singers' voices are unknown. Run the same search without `--vocals` and check the multi-artist rows yourself. Wikidata and MusicBrainz miss many small Norwegian artists. Ask the user about the ones you cannot place, and record each answer with `ft voice`.
- If Spotify is not authorized, tell the user to run `ft auth`.
- Do not edit the SQLite file directly.
