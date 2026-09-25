import { expect, test } from 'bun:test';
import { extractLyrics } from '../src/lyrics/genius';

test('extracts Genius lyrics containers and skips excluded headers', async () => {
  const html = `
    <html><body>
      <div data-lyrics-container="true">
        <div data-exclude-from-selection="true"><span>12 Contributors</span>Magic Lyrics</div>
        [Verse 1]<br/>I&#x27;m up in the air<br><a href="#"><span>Oh ho ho, it&apos;s magic</span></a>
      </div>
      <div class="ad">Buy now</div>
      <div data-lyrics-container="true">You know &amp; never believe</div>
    </body></html>`;
  expect(await extractLyrics(html)).toBe(
    "[Verse 1]\nI'm up in the air\nOh ho ho, it's magic\n\nYou know & never believe",
  );
});

test('returns nothing for pages without lyrics', async () => {
  expect(await extractLyrics('<html><body>403</body></html>')).toBeUndefined();
});
