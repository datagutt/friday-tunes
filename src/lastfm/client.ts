import { Data, Duration, Effect, RateLimiter, Redacted, Schema } from 'effect';
import { lastfm } from '../config';
import { HttpError, RateLimited, requestJson, retryTransient } from '../http';

const API = 'https://ws.audioscrobbler.com/2.0/';

// The Last.fm ToS allows about 5 calls per second per IP.
const CALLS_PER_SECOND = 4;

export class LastFmNotFound extends Data.TaggedError('LastFmNotFound')<{
  readonly method: string;
}> {}

const ApiError = Schema.Struct({
  error: Schema.Number,
  message: Schema.String,
});
const decodeApiError = Schema.decodeUnknownOption(ApiError);

// Last.fm reports errors as JSON, sometimes with HTTP 200. Code 29 is the
// rate limit; 8, 11 and 16 are temporary outages worth retrying.
const checkApiError = (
  method: string,
  url: string,
  json: unknown,
): Effect.Effect<unknown, HttpError | RateLimited | LastFmNotFound> => {
  const apiError = decodeApiError(json);
  if (apiError._tag === 'None') return Effect.succeed(json);
  const { error, message } = apiError.value;
  if (error === 29) {
    return Effect.fail(
      new RateLimited({ service: 'lastfm', retryAfter: Duration.seconds(10) }),
    );
  }
  if (error === 6) return Effect.fail(new LastFmNotFound({ method }));
  return Effect.fail(
    new HttpError({
      service: 'lastfm',
      method: 'GET',
      url,
      status: [8, 11, 16].includes(error) ? 503 : 400,
      body: `error ${error}: ${message}`,
    }),
  );
};

const parseErrorBody = (error: HttpError) => {
  try {
    return JSON.parse(error.body) as unknown;
  } catch {
    return undefined;
  }
};

export class LastFm extends Effect.Service<LastFm>()('LastFm', {
  scoped: Effect.gen(function* () {
    const config = yield* lastfm;
    const limiter = yield* RateLimiter.make({
      limit: CALLS_PER_SECOND,
      interval: '1 second',
    });

    const call = <A, I>(
      schema: Schema.Schema<A, I>,
      method: string,
      params: Record<string, string | number | undefined>,
    ) => {
      const url = new URL(API);
      url.search = new URLSearchParams({
        method,
        api_key: Redacted.value(config.apiKey),
        format: 'json',
        ...Object.fromEntries(
          Object.entries(params).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, String(v)]],
          ),
        ),
      }).toString();
      const href = url.toString();
      return retryTransient(
        limiter(requestJson('lastfm', href)).pipe(
          Effect.catchIf(
            (e): e is HttpError =>
              e instanceof HttpError && parseErrorBody(e) !== undefined,
            (e) => checkApiError(method, href, parseErrorBody(e)),
          ),
          Effect.flatMap((json) => checkApiError(method, href, json)),
        ),
      ).pipe(Effect.flatMap(Schema.decodeUnknown(schema)));
    };

    return { call, user: config.user };
  }),
}) {}
