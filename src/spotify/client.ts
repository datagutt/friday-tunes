import {
  Chunk,
  Effect,
  Option,
  RateLimiter,
  Schema,
  Stream,
  SynchronizedRef,
} from 'effect';
import { HttpError, requestJson, retryTransient } from '../http';
import { readToken, refreshToken, type Token } from './auth';
import { Paging } from './schema';

const API = 'https://api.spotify.com/v1/';

// Spotify counts dev-mode calls over a rolling 30 s window and does not
// publish the budget. This pace stays under it for multi-hour catalog syncs.
const CALLS_PER_SECOND = 5;

export interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
}

const buildUrl = (pathOrUrl: string, query: CallOptions['query'] = {}) => {
  const url = new URL(
    pathOrUrl.startsWith('https://') ? pathOrUrl : API + pathOrUrl,
  );
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
};

export class Spotify extends Effect.Service<Spotify>()('Spotify', {
  scoped: Effect.gen(function* () {
    const limiter = yield* RateLimiter.make({
      limit: CALLS_PER_SECOND,
      interval: '1 second',
    });
    const token = yield* SynchronizedRef.make<Token>(yield* readToken);

    const accessToken = (force: boolean) =>
      SynchronizedRef.updateAndGetEffect(token, (current) =>
        force || current.expiresAt - Date.now() < 60_000
          ? refreshToken(current)
          : Effect.succeed(current),
      ).pipe(Effect.map((t) => t.accessToken));

    const send = (url: string, options: CallOptions, force: boolean) =>
      accessToken(force).pipe(
        Effect.flatMap((bearer) =>
          limiter(
            requestJson('spotify', url, {
              method: options.method ?? 'GET',
              headers: {
                Authorization: `Bearer ${bearer}`,
                ...(options.body === undefined
                  ? {}
                  : { 'Content-Type': 'application/json' }),
              },
              body:
                options.body === undefined
                  ? undefined
                  : JSON.stringify(options.body),
            }),
          ),
        ),
      );

    const call = (pathOrUrl: string, options: CallOptions = {}) => {
      const url = buildUrl(pathOrUrl, options.query);
      return retryTransient(
        send(url, options, false).pipe(
          // An access token can be revoked before its expiry; refresh once.
          Effect.catchIf(
            (e) => e instanceof HttpError && e.status === 401,
            () => send(url, options, true),
          ),
        ),
      );
    };

    const get = <A, I>(
      schema: Schema.Schema<A, I>,
      pathOrUrl: string,
      query?: CallOptions['query'],
    ) =>
      call(pathOrUrl, { query }).pipe(
        Effect.flatMap(Schema.decodeUnknown(schema)),
      );

    // Streams every item of a Spotify paging object by following `next`.
    const paginate = <A, I>(
      item: Schema.Schema<A, I>,
      path: string,
      query?: CallOptions['query'],
    ) => {
      const page = Paging(item);
      return Stream.paginateChunkEffect(buildUrl(path, query), (url) =>
        get(page, url).pipe(
          Effect.map(
            (p) =>
              [
                Chunk.fromIterable(p.items),
                Option.fromNullable(p.next),
              ] as const,
          ),
        ),
      );
    };

    return { call, get, paginate };
  }),
}) {}
