import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDirection, detectMoves, plan, type Entry, type Snapshot, type SyncDirection } from "./sync.ts";

const file = (path: string, size = 10, mtime = 1_000_000): Entry => ({ path, isDir: false, mtime, size });
const snap = (...entries: Entry[]): Snapshot =>
	Object.fromEntries(entries.map((e) => [e.path, { mtime: e.mtime, size: e.size, isDir: false }]));

const run = (local: Entry[], remote: Entry[], snapshot: Snapshot, direction: SyncDirection = "both") =>
	detectMoves(applyDirection(plan(local, remote, snapshot), direction), local, remote, snapshot);

test("local rename becomes one remote move", () => {
	assert.deepEqual(run([file("b.md")], [file("a.md")], snap(file("a.md"))), [
		{ type: "moveRemote", from: "a.md", path: "b.md" },
	]);
});

test("remote rename becomes one local move", () => {
	assert.deepEqual(run([file("a.md")], [file("b.md")], snap(file("a.md"))), [
		{ type: "moveLocal", from: "a.md", path: "b.md" },
	]);
});

test("two identical candidates are not guessed", () => {
	const actions = run([file("b.md"), file("c.md")], [file("a.md")], snap(file("a.md")));
	assert.ok(actions.every((a) => a.type !== "moveRemote"));
});

test("rename plus edit falls back to delete and upload", () => {
	const actions = run([file("b.md", 20)], [file("a.md")], snap(file("a.md")));
	assert.deepEqual(actions.map((a) => a.type).sort(), ["delRemote", "upload"]);
});

test("push mode restores a remote rename instead of moving", () => {
	const actions = run([file("a.md")], [file("b.md")], snap(file("a.md")), "push");
	assert.deepEqual(actions, [{ type: "upload", path: "a.md" }]);
});
