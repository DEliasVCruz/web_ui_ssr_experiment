import { Database } from "bun:sqlite";

const DEFAULT_DB_PATH = "./data/todos.db";

let db: Database | null = null;

export function getDb(): Database {
	if (db) return db;

	const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
	db = new Database(dbPath, { create: true });

	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");

	db.exec(`
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
