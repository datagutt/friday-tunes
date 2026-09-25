// Normalized keys decide when a Last.fm scrobble, a liked song and a
// playlist entry are the same song. Remasters, radio edits and featured
// artists collapse into one key. Remixes, live and acoustic versions stay
// separate because they sound different and themes may want one of them.

const FEATURING =
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/giu;
const TRAILING_FEATURING = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/iu;
const EDITION =
  /\s*(?:-\s+|[([]\s*)(?:\d{4}\s+)?(?:remaster(?:ed)?|re-?master(?:ed)?|radio edit|single version|album version|mono|stereo|explicit|clean)(?:\s+(?:version|edit|\d{4}))?(?:\s+\d{4})?\s*[)\]]?\s*$/iu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

const base = (value: string) => value.normalize('NFC').toLowerCase();

const squash = (value: string) => value.replace(NON_WORD, ' ').trim();

export const normalizeTitle = (title: string) => {
  let result = base(title).replace(FEATURING, '');
  let previous: string;
  do {
    previous = result;
    result = result.replace(EDITION, '');
  } while (result !== previous);
  return squash(result.replace(TRAILING_FEATURING, ''));
};

export const normalizeArtist = (name: string) => squash(base(name));

export const matchKey = (primaryArtist: string, title: string) =>
  `${normalizeArtist(primaryArtist)}::${normalizeTitle(title)}`;
