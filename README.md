# friday-tunes

A local index of one person's music history, built for themed playlists. Every Friday at 15:00 work posts a music theme ("songs that evoke magic", "a color in the title"). A Claude Code skill searches this index, proposes a grouped list, and creates a private Spotify playlist after approval.

The index lives in SQLite. It combines these sources:
- Spotify: Liked Songs, own playlists, top and recent tracks, followed artists.
- Last.fm: every scrobble since the account started, top artists, and track and artist tags.
- Catalogs of followed and top artists: Last.fm top tracks, plus Spotify discographies that fill in slowly.
- Lyrics from LRCLIB, with Genius as a fallback.
- Genius notes: each song's About text and its top listener annotations.
- Artist bios from Last.fm and Genius. They are stored but not embedded: in tests they pulled unrelated artists into every artist search.
- Song summaries from a local Ollama language model: two sentences on what each song is about, plus the playlist themes it would fit. Only songs with lyrics or Genius notes get one, so the model summarizes text instead of guessing from a title.
- Embeddings from a local Ollama model, for vibe searches. Tracks are embedded from their title, tags, lyrics and Genius notes. Artists are embedded from their tags, because a theme like "autumn" is mostly about how an artist sounds.

## Setup

You need macOS, Bun, and a Spotify developer app (the one from spotify-mcp-server works).

1. Install the native pieces:
   ```sh
   brew install sqlite ollama
   brew services start ollama
   ollama pull bge-m3
   ollama pull gemma4:26b-mlx
   ```
   The summary model runs on Ollama's MLX engine and needs about 18 GB of memory while it works. Set `OLLAMA_SUMMARY_MODEL` to use another one.
2. Install dependencies and link the CLI and the skill:
   ```sh
   bun install
   ln -s "$PWD/bin/ft" ~/.local/bin/ft
   ln -s "$PWD/skill" ~/.claude/skills/friday-tunes
   ```
3. Copy `.env.example` to `.env` and fill it in. Get a Last.fm key at https://www.last.fm/api/account/create. A Genius token (https://genius.com/api-clients) is optional.
4. Log in to Spotify, run the first sync, and install the schedule:
   ```sh
   ft auth
   ft sync --full
   ft schedule install
   ```

The first full sync walks the whole Last.fm history (200 scrobbles per call) and fetches tags and lyrics for the library. Expect it to take an hour or more. Every step saves its progress, so you can stop it and run it again.

## Use

In Claude Code, give the theme: "Friday theme: songs with a color in the title". The skill does the rest.

The CLI also works on its own:
```sh
ft search title magic
ft search title 'witch*' --source liked
ft search artist aurora --json
ft search lyrics rain
ft search meaning "written about his father"
ft search about "cold war"
ft search about-vibe "anti-war protest songs"
ft search tag "dream pop" --min-plays 5
ft search vibe "enchanted forest, fairytale"
ft search artist-vibe "indie folk, acoustic, nordic folk"
ft search year 1990-1999 --exclude-tag metal
ft theme --vibe "magical, enchanting" --sound "dream pop, ethereal, folk" \
  --word magic --word 'witch*' --tag "dream pop" --exclude-tag metal --clean
ft theme --vibe "halloween, spooky, haunted" --avoid christmas --word ghost
ft playlist create --name "Magic" 506 912 786
ft playlist add https://open.spotify.com/playlist/... 1602 10239
ft playlist remove https://open.spotify.com/playlist/... 1602
ft stats
```

A search runs a quick sync first when the index is more than 12 hours old. Pass `--no-sync` to skip it.

## Sync

- `ft sync` runs the quick steps: `spotify` and `lastfm`.
- `ft sync --full` also runs `catalog`, `discography`, `tags`, `bios`, `lyrics`, `genius`, `summary` and `embed`.
- `ft sync --step <name>` runs one step. Repeat `--step` for several.
- `--summary-minutes <n>` stops the `summary` step after n minutes. Without it, the step runs until it is done.

`ft schedule install` adds two launchd jobs. A full sync runs on Fridays at 13:00. A trickle job runs the `discography`, `genius` and `summary` steps every hour; each run spends a small call budget, so they fill in over days without tripping rate limits. The `genius` step spends its budget on songs first and artist bios after. Both jobs pass `--summary-minutes 20`, so the `summary` step writes for 20 minutes per run, library songs first, and the Mac is not busy for hours. `ft sync --step summary` started by hand has no limit and runs until every song is summarized, which takes hours on the first pass. Logs go to `data/launchd.log`. If the Mac sleeps through a run, launchd starts it on wake. If the Mac is off, the run is skipped.

## Things that will surprise you

- **Spotify limits.** A development mode Spotify app gets a small, unpublished call budget. A few minutes at 5 calls per second earned a block of almost 23 hours, for every tool that uses the same client ID. friday-tunes therefore does most discovery through Last.fm and calls Spotify at 2 calls per second. It spends Spotify calls on discographies only in small hourly slices. When Spotify answers with a long `Retry-After`, the index stores the time and makes no Spotify calls until then.
- **Other people's playlists.** Spotify returns no contents for playlists the user neither owns nor collaborates on. Those are stored as `not_owned`. Some owned playlists also break Spotify's paging, and the sync skips them with a warning.
- **One row per song.** Album, single and remaster versions share one row, keyed on the normalized primary artist and title. Remixes, live and acoustic versions stay separate. See `src/normalize.ts`.
- **Lazy Spotify IDs.** Tracks that come only from Last.fm have no Spotify ID. The `ft playlist` commands look them up when they need them and cache the result, including misses. When a song is not on Spotify, they list other indexed versions of it.
- **Explicit is often unknown.** The explicit flag comes from Spotify, so scrobble-only tracks have none until a playlist command looks them up. `--clean` keeps unknown tracks.
- **Tags come from artists.** Last.fm has track tags for few songs. Nearly every track still carries its artists' tags, so tag searches find genres well and occasions like "halloween" poorly.
- **Apple SQLite.** The system SQLite on macOS cannot load extensions, and sqlite-vec is one. friday-tunes loads Homebrew's SQLite instead. Set `SQLITE_LIB` if yours lives elsewhere.

## Development

```sh
bun test
bun run typecheck
bun run lint
```

### Measuring search quality

`ft theme` has no trained model, only signal weights and the text that gets embedded. Measure a change before keeping it. `ft eval` replays past themes from `data/eval.json` and reports how many of the tracks that made each final playlist rank in the top 20 and top 50. Each entry holds the theme, the `ft theme` arguments an agent would pass for it, and the approved tracks as Spotify links or title and artist pairs:

```json
[
  {
    "theme": "(Nobel) Peace (Prize)",
    "vibe": "songs about war and peace, anti-war protest",
    "sound": "60s folk rock, protest folk",
    "words": ["war", "peace", "bomb", "fred"],
    "source": "any",
    "tracks": [
      "https://open.spotify.com/track/...",
      { "title": "99 Luftballons", "artist": "Nena" }
    ]
  }
]
```

Tracks the index does not hold are listed as `not in index` and left out of the score, since no search could find them.

## License

MIT. See `LICENSE`.
