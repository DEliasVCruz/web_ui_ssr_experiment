import { create, isFieldSet } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	TodoSchema,
	type TodoService,
	UpdateTodoRequestSchema,
} from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";
import {
	createTodo,
	deleteTodo,
	getTodo,
	listTodos,
	type TodoRow,
	updateTodo,
} from "./todo-repository";

function todoFromRow(row: TodoRow) {
	return create(TodoSchema, {
		id: row.id,
		title: row.title,
		completed: Boolean(row.completed),
		createdAt: timestampFromDate(new Date(row.createdAt)),
		updatedAt: timestampFromDate(new Date(row.updatedAt)),
	});
}

export const todoServiceImpl: ServiceImpl<typeof TodoService> = {
	listTodos() {
		const rows = listTodos();
		return { todos: rows.map(todoFromRow) };
	},

	getTodo(request) {
		const row = getTodo(request.id);
		if (!row) {
			throw new ConnectError("todo not found", Code.NotFound);
		}
		return { todo: todoFromRow(row) };
	},

	createTodo(request) {
		const row = createTodo(request.title);
		return { todo: todoFromRow(row) };
	},

	updateTodo(request) {
		// With editions 2023, explicit-presence scalar fields read as their default
		// value when unset; use isFieldSet to distinguish "unset" from "set to default".
		const row = updateTodo(request.id, {
			title: isFieldSet(request, UpdateTodoRequestSchema.field.title) ? request.title : undefined,
			completed: isFieldSet(request, UpdateTodoRequestSchema.field.completed)
				? request.completed
				: undefined,
		});
		if (!row) {
			throw new ConnectError("todo not found", Code.NotFound);
		}
		return { todo: todoFromRow(row) };
	},

	deleteTodo(request) {
		const deleted = deleteTodo(request.id);
		if (!deleted) {
			throw new ConnectError("todo not found", Code.NotFound);
		}
		return {};
	},
};
