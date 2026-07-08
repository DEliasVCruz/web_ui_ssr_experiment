import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_DB_PATH = "./data/todos.db";

let db: Database | null = null;

export function getDb(): Database {
	if (db) return db;

	const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
	// `new Database(path, { create: true })` creates the DB file but NOT its
	// parent directory — a missing dir (e.g. a fresh checkout with no `data/`)
	// makes the open fail and surfaces as 500s on every RPC. Ensure it exists.
	mkdirSync(dirname(dbPath), { recursive: true });
	db = new Database(dbPath, { create: true });

	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA foreign_keys = ON;");

	db.run(`
		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			completed INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}
