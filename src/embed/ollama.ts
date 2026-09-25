import { Effect, Schema } from 'effect';
import { ollama } from '../config';
import { requestJson, retryTransient } from '../http';

const EmbedResponse = Schema.Struct({
  embeddings: Schema.Array(Schema.Array(Schema.Number)),
});

export const embed = (input: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const config = yield* ollama;
    const json = yield* retryTransient(
      requestJson('ollama', `${config.url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, input, truncate: true }),
      }),
      2,
    );
    const { embeddings } = yield* Schema.decodeUnknown(EmbedResponse)(json);
    return embeddings.map((e) => new Float32Array(e));
  });
