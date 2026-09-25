import { Data, Duration, Effect, Schedule } from 'effect';
import { USER_AGENT } from './config';

export class HttpError extends Data.TaggedError('HttpError')<{
  readonly service: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `${this.service} ${this.method} ${redact(this.url)} failed (${this.status}): ${this.body.slice(0, 300)}`;
  }
}

export class RateLimited extends Data.TaggedError('RateLimited')<{
  readonly service: string;
  readonly retryAfter: Duration.Duration;
}> {
  override get message() {
    return `${this.service} rate limit hit, retry after ${Duration.format(this.retryAfter)}`;
  }
}

export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly service: string;
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.service} request to ${redact(this.url)} failed: ${String(this.cause)}`;
  }
}

export type RequestError = HttpError | RateLimited | NetworkError;

// Last.fm puts the API key in the query string; keep it out of error output.
const redact = (url: string) =>
  url.replace(/([?&](?:api_key|access_token)=)[^&]+/g, '$1***');

const parseRetryAfter = (header: string | null) => {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Duration.seconds(seconds)
    : Duration.seconds(5);
};

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | URLSearchParams;
}

export const request = (
  service: string,
  url: string,
  options: RequestOptions = {},
) => {
  const method = options.method ?? 'GET';
  return Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        method,
        body: options.body,
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
        signal,
      }),
    catch: (cause) => new NetworkError({ service, url, cause }),
  }).pipe(
    Effect.flatMap(
      (response): Effect.Effect<Response, HttpError | RateLimited> => {
        if (response.status === 429) {
          return Effect.fail(
            new RateLimited({
              service,
              retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
            }),
          );
        }
        if (!response.ok) {
          return Effect.promise(() => response.text()).pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new HttpError({
                  service,
                  method,
                  url,
                  status: response.status,
                  body,
                }),
              ),
            ),
          );
        }
        return Effect.succeed(response);
      },
    ),
  );
};

export const requestJson = (
  service: string,
  url: string,
  options: RequestOptions = {},
) =>
  request(service, url, options).pipe(
    Effect.flatMap((response) =>
      Effect.promise(() => response.text()).pipe(
        Effect.map((text): unknown => (text ? JSON.parse(text) : undefined)),
      ),
    ),
  );

// Spotify can answer a burst with a Retry-After of several hours. Waiting
// that out inside one sync looks like a hang, so a long wait fails the
// request instead and the next sync resumes.
const MAX_RATE_LIMIT_WAIT = Duration.minutes(5);

const isTransient = (error: unknown) =>
  error instanceof RateLimited
    ? Duration.lessThanOrEqualTo(error.retryAfter, MAX_RATE_LIMIT_WAIT)
    : error instanceof NetworkError ||
      (error instanceof HttpError && error.status >= 500);

// Exponential backoff for flaky errors, but a rate limit always waits at
// least as long as the server asked for.
export const retryTransient = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  retries = 6,
) =>
  Effect.retry(
    self.pipe(
      Effect.tapError((error) =>
        error instanceof RateLimited
          ? Effect.logWarning(error.message)
          : Effect.void,
      ),
    ),
    {
      while: isTransient,
      schedule: Schedule.exponential('500 millis').pipe(
        Schedule.intersect(Schedule.identity<E>()),
        Schedule.addDelay(([, error]) =>
          error instanceof RateLimited ? error.retryAfter : Duration.zero,
        ),
        Schedule.intersect(Schedule.recurs(retries)),
      ),
    },
  );
