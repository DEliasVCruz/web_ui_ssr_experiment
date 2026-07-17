import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/solid-query";
import { settleInvalidate } from "../queries/todos";

// The offline guard on the a4a.3 keep-pending-until-refetch invalidation (1w9.4
// §4.5): ONLINE it returns the invalidation promise (query-core holds the mutation
// pending until the refetched truth lands); OFFLINE it fires the invalidation but
// returns undefined, so a mutation settling while disconnected is never wedged
// pending on a refetch that cannot complete.

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setOnLine(value: boolean): void {
	Object.defineProperty(globalThis, "navigator", {
		value: { onLine: value },
		configurable: true,
		writable: true,
	});
}

afterEach(() => {
	if (originalDescriptor) {
		Object.defineProperty(globalThis, "navigator", originalDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "navigator");
	}
});

describe("settleInvalidate offline guard", () => {
	const key = [["listTodos"]] as const;

	test("online: RETURNS the invalidation promise (keep-pending)", async () => {
		setOnLine(true);
		const client = new QueryClient();
		const result = settleInvalidate(client, key);
		expect(result).toBeInstanceOf(Promise);
		await result; // resolves cleanly on an empty cache
	});

	test("offline: fires-and-forgets, returns undefined (never wedges pending)", () => {
		setOnLine(false);
		const client = new QueryClient();
		const result = settleInvalidate(client, key);
		expect(result).toBeUndefined();
	});
});
