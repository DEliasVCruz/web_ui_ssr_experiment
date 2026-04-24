import { randomUUIDv7 } from "bun";
import { getDb } from "./db";

export interface TodoRow {
	id: string;
	title: string;
	completed: number;
	createdAt: string;
	updatedAt: string;
}

interface SqliteRow {
	id: string;
	title: string;
	completed: number;
	// biome-ignore lint/style/useNamingConvention: matches SQLite column name
	created_at: string;
	// biome-ignore lint/style/useNamingConvention: matches SQLite column name
	updated_at: string;
}

function toTodoRow(row: SqliteRow): TodoRow {
	return {
		id: row.id,
		title: row.title,
		completed: row.completed,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function listTodos(): TodoRow[] {
	const db = getDb();
	const rows = db.query("SELECT * FROM todos ORDER BY created_at DESC").all() as SqliteRow[];
	return rows.map(toTodoRow);
}

export function getTodo(id: string): TodoRow | null {
	const db = getDb();
	const row = db.query("SELECT * FROM todos WHERE id = ?").get(id) as SqliteRow | null;
	return row ? toTodoRow(row) : null;
}

export function createTodo(title: string): TodoRow {
	const db = getDb();
	const id = randomUUIDv7();
	const now = new Date().toISOString();

	db.query(
		"INSERT INTO todos (id, title, completed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
	).run(id, title, now, now);

	return getTodo(id) as TodoRow;
}

export function updateTodo(
	id: string,
	fields: { title?: string; completed?: boolean },
): TodoRow | null {
	const db = getDb();
	const existing = getTodo(id);
	if (!existing) return null;

	const title = fields.title ?? existing.title;
	const completed = fields.completed === undefined ? existing.completed : Number(fields.completed);
	const now = new Date().toISOString();

	db.query("UPDATE todos SET title = ?, completed = ?, updated_at = ? WHERE id = ?").run(
		title,
		completed,
		now,
		id,
	);

	return getTodo(id);
}

export function deleteTodo(id: string): boolean {
	const db = getDb();
	const result = db.query("DELETE FROM todos WHERE id = ?").run(id);
	return result.changes > 0;
}
