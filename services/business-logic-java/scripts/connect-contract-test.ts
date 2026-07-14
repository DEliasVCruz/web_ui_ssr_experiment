/**
 * Cross-client contract test for the Java Connect-unary adapter.
 *
 * Uses the real connect-es stack — the generated TodoService client from
 * `@web-ui-poc/rpc` over `createConnectTransport({ useBinaryFormat: true })`
 * from `@connectrpc/connect-node` — against the Java server serving the
 * StubTodoService test fixture.
 *
 * Start the server first (from the repo root, inside devenv):
 *
 *   mvn -q -f services/business-logic-java test-compile exec:java \
 *       -DmainClass=com.webuipoc.connect.ContractTestServer \
 *       -Dexec.classpathScope=test
 *
 * Then run this script (BASE_URL overrides the default http://localhost:3911):
 *
 *   bun run --filter @web-ui-poc/business-logic-java contract-test
 */
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { TodoService } from "@web-ui-poc/rpc/gen/todo/v1/todo_pb";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3911";

// Magic StubTodoService ids (see StubTodoService.java). Syntactically valid
// UUIDs so they pass the protovalidate string.uuid constraint on GetTodoRequest.id.
const ECHO_ID = "8b3e1a1e-6f2a-4b57-9f3e-2d4c5a6b7c8d";
const MISSING_ID = "00000000-0000-0000-0000-000000000404";
const TITLE_MAX_LEN = 100;

const transport = createConnectTransport({
	baseUrl,
	httpVersion: "1.1",
	useBinaryFormat: true,
});
const client = createClient(TodoService, transport);

let failures = 0;

// detail is lazy: protobuf-es messages contain BigInt fields (Timestamp
// seconds), which JSON.stringify cannot serialize eagerly.
function check(name: string, condition: boolean, detail: () => string): void {
	if (condition) {
		// biome-ignore lint/suspicious/noConsole: CLI test output
		console.log(`PASS ${name}`);
	} else {
		failures += 1;
		// biome-ignore lint/suspicious/noConsole: CLI test output
		console.error(`FAIL ${name}: ${detail()}`);
	}
}

function describe(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		typeof field === "bigint" ? field.toString() : field,
	);
}

// 1. Round trip: binary unary request/response through the generated client.
const got = await client.getTodo({ id: ECHO_ID });
check(
	"getTodo round-trip",
	got.todo?.id === ECHO_ID && got.todo.title === "stub-todo",
	() => `unexpected response: ${describe(got)}`,
);
check(
	"getTodo timestamps decode",
	got.todo?.createdAt !== undefined,
	() => "createdAt missing from decoded todo",
);

const created = await client.createTodo({ title: "from-connect-es" });
check(
	"createTodo round-trip",
	created.todo?.id === "created-1" && created.todo.title === "from-connect-es",
	() => `unexpected response: ${describe(created)}`,
);

const listed = await client.listTodos({});
const expectedTodoCount = 2;
check(
	"listTodos round-trip",
	listed.todos.length === expectedTodoCount,
	() => `expected ${String(expectedTodoCount)} todos, got ${String(listed.todos.length)}`,
);

// 2. Error mapping: NOT_FOUND from the service surfaces as a ConnectError
//    with code NotFound and the server's message.
try {
	await client.getTodo({ id: MISSING_ID });
	check("getTodo NOT_FOUND surfaces as ConnectError", false, () => "no error was thrown");
} catch (error) {
	const isConnectError = error instanceof ConnectError;
	const connectError = ConnectError.from(error);
	check(
		"getTodo NOT_FOUND surfaces as ConnectError",
		isConnectError && connectError.code === Code.NotFound,
		() => `expected ConnectError with code NotFound, got: ${String(error)}`,
	);
	check(
		"NOT_FOUND message is preserved",
		connectError.rawMessage === `todo "${MISSING_ID}" not found`,
		() => `unexpected message: ${connectError.rawMessage}`,
	);
}

// 3. protovalidate enforcement: constraint violations surface as ConnectError
//    with code InvalidArgument naming the violated field.
async function expectInvalidArgument(
	name: string,
	call: () => Promise<unknown>,
	expectedFieldInMessage: string,
): Promise<void> {
	try {
		await call();
		check(name, false, () => "no error was thrown");
	} catch (error) {
		const isConnectError = error instanceof ConnectError;
		const connectError = ConnectError.from(error);
		check(
			name,
			isConnectError &&
				connectError.code === Code.InvalidArgument &&
				connectError.rawMessage.includes(expectedFieldInMessage),
			() =>
				`expected ConnectError(InvalidArgument) mentioning "${expectedFieldInMessage}", got: ${String(error)}`,
		);
	}
}

await expectInvalidArgument(
	"createTodo with empty title is rejected",
	() => client.createTodo({ title: "" }),
	"title",
);

await expectInvalidArgument(
	"createTodo with a 101-char title is rejected",
	() => client.createTodo({ title: "x".repeat(TITLE_MAX_LEN + 1) }),
	"title",
);

const maxTitle = "y".repeat(TITLE_MAX_LEN);
const maxTitleCreated = await client.createTodo({ title: maxTitle });
check(
	"createTodo with a 100-char title is accepted",
	maxTitleCreated.todo?.title === maxTitle,
	() => `unexpected response: ${describe(maxTitleCreated)}`,
);

await expectInvalidArgument(
	"getTodo with a non-UUID id is rejected",
	() => client.getTodo({ id: "not-a-uuid" }),
	"id",
);

// UpdateTodoRequest.title has explicit presence: the min_len rule applies only
// when the field is set, so an update without a title must pass validation.
const updatedWithoutTitle = await client.updateTodo({ id: ECHO_ID, completed: true });
check(
	"updateTodo without title set passes validation",
	updatedWithoutTitle.todo?.title === "unchanged",
	() => `unexpected response: ${describe(updatedWithoutTitle)}`,
);

await expectInvalidArgument(
	"updateTodo with empty title set is rejected",
	() => client.updateTodo({ id: ECHO_ID, title: "" }),
	"title",
);

if (failures > 0) {
	// biome-ignore lint/suspicious/noConsole: CLI test output
	console.error(`${String(failures)} contract check(s) failed`);
	process.exit(1);
}
// biome-ignore lint/suspicious/noConsole: CLI test output
console.log("all contract checks passed");
