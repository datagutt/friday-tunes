import { describe, expect, test } from 'bun:test';
import { matchKey, normalizeArtist, normalizeTitle } from '../src/normalize';

describe('normalizeTitle', () => {
  test.each([
    ['Wuthering Heights', 'wuthering heights'],
    ['Heroes - 2017 Remaster', 'heroes'],
    ['Heroes - Remastered 2011', 'heroes'],
    ['Time to Pretend (Remastered)', 'time to pretend'],
    ['Good Life (feat. T-Pain)', 'good life'],
    ['Good Life [feat. T-Pain]', 'good life'],
    ['Good Life feat. T-Pain', 'good life'],
    ['Empire Ants (feat. Little Dragon)', 'empire ants'],
    ['Song - Radio Edit', 'song'],
    ['Song - Single Version', 'song'],
    ['Song - Remastered 2009 - Mono', 'song'],
    ['Spell (Stullett Remix)', 'spell stullett remix'],
    ['Samurai Swords - Acoustic Version', 'samurai swords acoustic version'],
    ['Where Is My Mind - Live', 'where is my mind live'],
    ['Bro, eg elske damå di', 'bro eg elske damå di'],
    ['Jeg går ned med dette skipet', 'jeg går ned med dette skipet'],
    ['Ég skal bíða eftir þér', 'ég skal bíða eftir þér'],
    ['Hëłlœ Kįttÿ', 'hëłlœ kįttÿ'],
    ['へび', 'へび'],
    ['  MANNEN   ME LJÅEN ', 'mannen me ljåen'],
  ])('%p', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  test('NFD and NFC input give the same key', () => {
    expect(normalizeTitle('Små')).toBe(normalizeTitle('Små'));
  });
});

describe('normalizeArtist', () => {
  test.each([
    ['Bastian!', 'bastian'],
    ['H*nning', 'h nning'],
    ['BØRNS', 'børns'],
    ['Sa_G', 'sa g'],
  ])('%p', (input, expected) => {
    expect(normalizeArtist(input)).toBe(expected);
  });
});

test('matchKey joins artist and title', () => {
  expect(matchKey('AURORA', 'Life On Mars')).toBe('aurora::life on mars');
  expect(matchKey('David Bowie', 'Life On Mars? - 2015 Remaster')).toBe(
    'david bowie::life on mars',
  );
});
