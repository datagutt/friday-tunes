import fs from 'node:fs';
import path from 'node:path';
import { Data, Deferred, Effect, Redacted, Schema } from 'effect';
import { spotifyApp, spotifyTokenPath } from '../config';
import { HttpError, requestJson, retryTransient } from '../http';

// friday-tunes needs user-follow-read on top of what spotify-mcp-server asks
// for, so it keeps its own token file instead of sharing that one.
export const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'user-top-read',
  'user-read-recently-played',
  'user-follow-read',
];

export class NotAuthorized extends Data.TaggedError('NotAuthorized')<{
  readonly reason: string;
}> {
  override get message() {
    return `Spotify is not authorized (${this.reason}). Run \`ft auth\`.`;
  }
}

export const Token = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
});
export type Token = typeof Token.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optionalWith(Schema.Number, { default: () => 3600 }),
});

export const readToken = Effect.gen(function* () {
  const file = yield* spotifyTokenPath;
  if (!fs.existsSync(file)) {
    return yield* new NotAuthorized({ reason: 'no token file' });
  }
  return yield* Schema.decodeUnknown(Schema.parseJson(Token))(
    fs.readFileSync(file, 'utf8'),
  ).pipe(
    Effect.mapError(
      () => new NotAuthorized({ reason: 'unreadable token file' }),
    ),
  );
});

export const writeToken = (token: Token) =>
  Effect.flatMap(spotifyTokenPath, (file) =>
    Effect.sync(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
    }),
  );

const tokenRequest = (form: Record<string, string>) =>
  Effect.gen(function* () {
    const app = yield* spotifyApp;
    const basic = btoa(`${app.clientId}:${Redacted.value(app.clientSecret)}`);
    const json = yield* retryTransient(
      requestJson(
        'spotify-accounts',
        'https://accounts.spotify.com/api/token',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(form),
        },
      ),
    );
    return yield* Schema.decodeUnknown(TokenResponse)(json);
  });

export const refreshToken = (token: Token) =>
  tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
  }).pipe(
    Effect.map(
      (res): Token => ({
        accessToken: res.access_token,
        // Spotify sometimes rotates the refresh token; keep the old one otherwise.
        refreshToken: res.refresh_token ?? token.refreshToken,
        expiresAt: Date.now() + res.expires_in * 1000,
      }),
    ),
    Effect.tap(writeToken),
    Effect.catchIf(
      (e) => e instanceof HttpError && e.body.includes('invalid_grant'),
      () => Effect.fail(new NotAuthorized({ reason: 'refresh token revoked' })),
    ),
  );

export const authorize = Effect.gen(function* () {
  const app = yield* spotifyApp;
  const redirect = new URL(app.redirectUri);
  if (!['127.0.0.1', 'localhost'].includes(redirect.hostname)) {
    return yield* Effect.fail(
      new Error('SPOTIFY_REDIRECT_URI must point at 127.0.0.1 or localhost'),
    );
  }
  const state = crypto.randomUUID();
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    redirect_uri: app.redirectUri,
    scope: SCOPES.join(' '),
    state,
    show_dialog: 'true',
  }).toString();

  const code = yield* Deferred.make<string, Error>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: redirect.hostname,
        port: Number(redirect.port || 80),
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== redirect.pathname) {
            return new Response('Not found', { status: 404 });
          }
          const error = url.searchParams.get('error');
          const value = url.searchParams.get('code');
          if (error || !value || url.searchParams.get('state') !== state) {
            Deferred.unsafeDone(
              code,
              Effect.fail(
                new Error(`Spotify login failed: ${error ?? 'state mismatch'}`),
              ),
            );
            return new Response('Login failed. Check the terminal.', {
              status: 400,
            });
          }
          Deferred.unsafeDone(code, Effect.succeed(value));
          return new Response(
            'friday-tunes is authorized. You can close this tab.',
          );
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  );

  yield* Effect.logInfo(`Opening Spotify login: ${authUrl}`);
  yield* Effect.sync(() => Bun.spawn(['open', authUrl.toString()]));

  const res = yield* Deferred.await(code).pipe(
    Effect.flatMap((value) =>
      tokenRequest({
        grant_type: 'authorization_code',
        code: value,
        redirect_uri: app.redirectUri,
      }),
    ),
  );
  if (!res.refresh_token) {
    return yield* Effect.fail(new Error('Spotify returned no refresh token'));
  }
  yield* writeToken({
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: Date.now() + res.expires_in * 1000,
  });
}).pipe(Effect.scoped);
