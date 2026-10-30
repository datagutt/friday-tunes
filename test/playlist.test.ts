import { expect, test } from 'bun:test';
import { playlistId } from '../src/spotify/playlist';

test('playlistId accepts links, URIs and bare IDs', () => {
  expect(
    playlistId('https://open.spotify.com/playlist/4RqwghqChcUAPaH5pMCUEA?si=x'),
  ).toBe('4RqwghqChcUAPaH5pMCUEA');
  expect(playlistId('spotify:playlist:4RqwghqChcUAPaH5pMCUEA')).toBe(
    '4RqwghqChcUAPaH5pMCUEA',
  );
  expect(playlistId('4RqwghqChcUAPaH5pMCUEA')).toBe('4RqwghqChcUAPaH5pMCUEA');
});
