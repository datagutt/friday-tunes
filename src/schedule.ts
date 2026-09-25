import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { dataDir, ROOT } from './config';

interface Job {
  readonly label: string;
  readonly args: ReadonlyArray<string>;
  readonly timing: string;
  readonly summary: string;
}

const JOBS: ReadonlyArray<Job> = [
  {
    // The work theme drops Fridays at 15:00; a full sync at 13:00 leaves
    // time for slow enrichment to finish first.
    label: 'com.github.datagutt.friday-tunes',
    args: ['sync', '--full'],
    timing: `<key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>5</integer>
    <key>Hour</key>
    <integer>13</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>`,
    summary: '`ft sync --full` on Fridays at 13:00',
  },
  {
    // Each run spends a small Spotify call budget; hourly runs fill the
    // discographies over a couple of weeks without tripping rate limits.
    label: 'com.github.datagutt.friday-tunes.discography',
    args: ['sync', '--step', 'discography'],
    timing: `<key>StartInterval</key>
  <integer>3600</integer>`,
    summary: '`ft sync --step discography` every hour',
  },
];

const plistPath = (job: Job) =>
  path.join(os.homedir(), 'Library/LaunchAgents', `${job.label}.plist`);

const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const plist = (job: Job, logFile: string) => {
  const args = [path.join(ROOT, 'bin/ft'), ...job.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const envPath = `${path.join(os.homedir(), '.bun/bin')}:/opt/homebrew/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${job.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  ${job.timing}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(envPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
};

const launchctl = (...args: string[]) =>
  Effect.sync(() => Bun.spawnSync(['launchctl', ...args], { stderr: 'pipe' }));

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export const install = Effect.gen(function* () {
  const logFile = path.join(yield* dataDir, 'launchd.log');
  const lines: string[] = [];
  for (const job of JOBS) {
    const file = plistPath(job);
    yield* Effect.sync(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, plist(job, logFile));
    });
    // bootout fails when the job is not loaded yet; that is fine.
    yield* launchctl('bootout', `${domain()}/${job.label}`);
    const result = yield* launchctl('bootstrap', domain(), file);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(
          `launchctl bootstrap failed for ${job.label}: ${result.stderr.toString()}`,
        ),
      );
    }
    lines.push(`Installed ${job.label}: ${job.summary}.`);
  }
  return [...lines, `Both log to ${logFile}.`].join('\n');
});

export const uninstall = Effect.gen(function* () {
  for (const job of JOBS) {
    yield* launchctl('bootout', `${domain()}/${job.label}`);
    yield* Effect.sync(() => fs.rmSync(plistPath(job), { force: true }));
  }
  return `Removed ${JOBS.map((j) => j.label).join(', ')}.`;
});

export const runNow = Effect.gen(function* () {
  const [weekly] = JOBS;
  if (!weekly) return 'No jobs defined.';
  const result = yield* launchctl('kickstart', `${domain()}/${weekly.label}`);
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `launchctl kickstart failed; run \`ft schedule install\` first. ${result.stderr.toString()}`,
      ),
    );
  }
  return 'Started the weekly full sync. Follow it in data/launchd.log.';
});
