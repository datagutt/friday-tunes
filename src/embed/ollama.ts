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

const ChatResponse = Schema.Struct({
  message: Schema.Struct({ content: Schema.String }),
});

// The first JSON object in a reply. Models often wrap it in a Markdown
// code fence or add a sentence around it.
export const extractJson = (reply: string) => {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  return start >= 0 && end > start ? reply.slice(start, end + 1) : reply;
};

// Ollama's MLX engine refuses `format` ("structured output is
// unavailable"), so the prompt asks for JSON and the reply is decoded
// against the schema. A reply that does not fit fails with a ParseError.
export const chatJson = <A, I>(
  schema: Schema.Schema<A, I>,
  system: string,
  user: string,
) =>
  Effect.gen(function* () {
    const config = yield* ollama;
    const json = yield* retryTransient(
      requestJson('ollama', `${config.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.summaryModel,
          stream: false,
          think: false,
          options: { temperature: 0.2 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      }),
      2,
    );
    const { message } = yield* Schema.decodeUnknown(ChatResponse)(json);
    return yield* Schema.decodeUnknown(Schema.parseJson(schema))(
      extractJson(message.content),
    );
  });
