import path from 'node:path';
import { Config } from 'effect';

export const ROOT = path.resolve(import.meta.dir, '..');

export const dataDir = Config.string('FRIDAY_TUNES_DATA_DIR').pipe(
  Config.withDefault(path.join(ROOT, 'data')),
);

export const dbPath = dataDir.pipe(
  Config.map((dir) => path.join(dir, 'friday-tunes.db')),
);

export const spotifyTokenPath = dataDir.pipe(
  Config.map((dir) => path.join(dir, 'spotify-token.json')),
);

export const spotifyApp = Config.all({
  clientId: Config.string('SPOTIFY_CLIENT_ID'),
  clientSecret: Config.redacted('SPOTIFY_CLIENT_SECRET'),
  redirectUri: Config.string('SPOTIFY_REDIRECT_URI').pipe(
    Config.withDefault('http://127.0.0.1:8888/callback'),
  ),
});

export const lastfm = Config.all({
  apiKey: Config.redacted('LASTFM_API_KEY'),
  user: Config.string('LASTFM_USER'),
});

export const geniusToken = Config.option(
  Config.redacted('GENIUS_ACCESS_TOKEN'),
);

export const ollama = Config.all({
  url: Config.string('OLLAMA_URL').pipe(
    Config.withDefault('http://127.0.0.1:11434'),
  ),
  model: Config.string('OLLAMA_EMBED_MODEL').pipe(Config.withDefault('bge-m3')),
});

// Apple's system SQLite refuses to load extensions, and sqlite-vec is one.
export const sqliteLib = Config.string('SQLITE_LIB').pipe(
  Config.withDefault('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'),
);

export const USER_AGENT =
  'friday-tunes/0.1 (https://github.com/datagutt/friday-tunes)';
