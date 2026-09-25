import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Context, Effect, Layer } from 'effect';
import * as sqliteVec from 'sqlite-vec';
import { dbPath, sqliteLib } from '../config';
import { migrations } from './migrations';

export class Db extends Context.Tag('Db')<Db, Database>() {}

// bun:sqlite accepts a custom library only before the first Database opens,
// and only once per process.
let customSqliteSet = false;

const useCustomSqlite = (lib: string) => {
  if (customSqliteSet || process.platform !== 'darwin') return;
  if (!fs.existsSync(lib)) {
    throw new Error(
      `SQLite library not found at ${lib}. Run \`brew install sqlite\` or set SQLITE_LIB.`,
    );
  }
  Database.setCustomSQLite(lib);
  customSqliteSet = true;
};

export const migrate = (db: Database) => {
  const { user_version: current } = db
    .query<{ user_version: number }, []>('pragma user_version')
    .get() ?? { user_version: 0 };
  migrations.slice(current).forEach((sql, i) => {
    db.transaction(() => {
      db.run(sql);
      db.run(`pragma user_version = ${current + i + 1}`);
    })();
  });
};

export const openDatabase = (file: string, lib: string) => {
  useCustomSqlite(lib);
  if (file !== ':memory:')
    fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { strict: true });
  db.run('pragma journal_mode = wal');
  db.run('pragma foreign_keys = on');
  db.run('pragma busy_timeout = 5000');
  sqliteVec.load(db);
  migrate(db);
  return db;
};

const acquire = (file: string, lib: string) =>
  Effect.acquireRelease(
    Effect.sync(() => openDatabase(file, lib)),
    (db) => Effect.sync(() => db.close()),
  );

export const DbLive = Layer.scoped(
  Db,
  Effect.gen(function* () {
    const file = yield* dbPath;
    const lib = yield* sqliteLib;
    return yield* acquire(file, lib);
  }),
);

export const DbMemory = Layer.scoped(
  Db,
  Effect.flatMap(sqliteLib, (lib) => acquire(':memory:', lib)),
);
