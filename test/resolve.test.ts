import { expect, test } from 'bun:test';
import { pickCandidate } from '../src/spotify/resolve';
import type { Track } from '../src/spotify/schema';

const candidate = (
  id: string,
  name: string,
  artist: string,
  duration_ms = 200_000,
): Track => ({
  id,
  name,
  duration_ms,
  artists: [{ id: null, name: artist }],
});

const track = {
  id: 1,
  title: 'Moonlight Shadow',
  artist: 'Mike Oldfield',
  duration_ms: 215_000,
};

test('picks the normalized title and artist match closest in duration', () => {
  const picked = pickCandidate(track, [
    candidate('cover', 'Moonlight Shadow', 'Some Cover Band', 215_000),
    candidate(
      'long',
      'Moonlight Shadow - 2015 Remaster',
      'Mike Oldfield',
      260_000,
    ),
    null,
    candidate('close', 'Moonlight Shadow', 'Mike Oldfield', 214_000),
  ]);
  expect(picked?.id).toBe('close');
});

test('returns nothing when no candidate matches the song', () => {
  expect(
    pickCandidate(track, [
      candidate('remix', 'Moonlight Shadow (Remix)', 'Mike Oldfield'),
    ]),
  ).toBeUndefined();
});
