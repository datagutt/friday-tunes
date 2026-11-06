import { Effect } from 'effect';
import { syncMusicBrainzVoices } from './musicbrainz';
import { syncWikidataVoices } from './wikidata';

// Wikidata answers 50 artists per call, so it goes first and MusicBrainz
// only looks up the artists it could not place.
export const syncVoices = Effect.zipRight(
  syncWikidataVoices,
  syncMusicBrainzVoices,
);
