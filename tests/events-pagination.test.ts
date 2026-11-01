import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBoard } from "../src/service/index.js";
import { fixture, temporaryDirectory } from "./helpers.js";

describe("events, cursor pagination, and configuration", () => {
  it("orders global event sequence across projects and records each actor and agent owner", () => {
    const { board, admin, agent, owner, project, task } = fixture();
    const first = task();
    const before = board.listEvents(admin, { limit: 100 }).items.at(-1)!.seq;
    const claimed = board.claim(agent, first.id).task;
    const otherProject = board.createProject(admin, {
      key: "OTHER",
      name: "Other",
    });
    board.createTask(owner, {
      projectId: otherProject.id,
      title: "Human task",
      accountable: owner.principal.id,
    });
    board.updateTask(
      agent,
      first.id,
      { progress: "Progress" },
      { leaseToken: claimed.lease!.token },
    );
    const events = board.listEvents(admin, { after: before, limit: 100 }).items;
    expect(events.map((event) => event.seq)).toEqual([
      before + 1,
      before + 2,
      before + 3,
      before + 4,
    ]);
    expect(events[0]).toMatchObject({
      actor: agent.principal.id,
      owner: owner.principal.id,
      projectId: project.id,
      taskId: first.id,
    });
    expect(events[1]).toMatchObject({
      actor: admin.principal.id,
      owner: null,
      projectId: otherProject.id,
    });
    expect(events[2]).toMatchObject({ actor: owner.principal.id, owner: null });
    expect(events[3]).toMatchObject({
      actor: agent.principal.id,
      owner: owner.principal.id,
    });
  });

  it("uses numeric event cursors and resumes without gaps", () => {
    const { board, admin, task } = fixture();
    for (let index = 0; index < 15; index++) task(`Task ${index}`);
    const expected = board.listEvents(admin, { limit: 100 }).items;
    const actual = [];
    let cursor: string | undefined;
    do {
      const page = board.listEvents(admin, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      actual.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(actual).toEqual(expected);
  });

  it("paginates tasks in priority/id order and survives the cursor task leaving the query", () => {
    const { board, admin, task } = fixture();
    const high = task("High");
    const low = task("Low");
    const last = task("Last");
    board.updateTask(
      admin,
      high.id,
      { priority: 10 },
      { expectedVersion: high.version },
    );
    board.updateTask(
      admin,
      low.id,
      { priority: 5 },
      { expectedVersion: low.version },
    );
    const first = board.listTasks(admin, { limit: 1, status: "todo" });
    expect(first.items[0]?.id).toBe(high.id);
    board.claim(admin, high.id);
    const next = board.listTasks(admin, {
      limit: 1,
      status: "todo",
      cursor: first.nextCursor!,
    });
    expect(next.items[0]?.id).toBe(low.id);
    expect(
      board.listTasks(admin, {
        limit: 1,
        status: "todo",
        cursor: next.nextCursor!,
      }).items[0]?.id,
    ).toBe(last.id);
  });

  it("resumes resource lists after a cursor item is deleted", () => {
    const { board, admin, task, advance } = fixture();
    let item = task();
    for (const ref of ["one", "two", "three"]) {
      advance(1);
      item = board.addLink(
        admin,
        item.id,
        { kind: "url", ref },
        { expectedVersion: item.version },
      ).task;
    }
    const first = board.listLinks(admin, item.id, { limit: 1 });
    board.removeLink(
      admin,
      item.id,
      { linkId: first.items[0]!.id },
      {
        expectedVersion: item.version,
      },
    );
    expect(
      board
        .listLinks(admin, item.id, { limit: 10, cursor: first.nextCursor! })
        .items.map((link) => link.ref),
    ).toEqual(["two", "three"]);
  });

  it("uses only the caller's limit unless maxPageSize is explicitly configured", () => {
    const unlimited = fixture();
    for (let index = 0; index < 120; index++) unlimited.task();
    expect(
      unlimited.board.listTasks(unlimited.admin, { limit: 120 }).items,
    ).toHaveLength(120);
    const limited = fixture({}, { maxPageSize: 2 });
    for (let index = 0; index < 3; index++) limited.task();
    expect(
      limited.board.listTasks(limited.admin, { limit: 100 }).items,
    ).toHaveLength(2);
    expect(
      limited.board.listPrincipals(limited.admin, { limit: 100 }).items,
    ).toHaveLength(2);
    expect(
      limited.board.listEvents(limited.admin, { limit: 100 }).items,
    ).toHaveLength(2);
  });

  it.each([undefined, 2])(
    "uses maxPageSize %s when limit is omitted and resumes from cursors",
    (maxPageSize) => {
      const { board, admin, task } = fixture({}, { maxPageSize });
      for (const title of ["First", "Second", "Third"]) task(title);
      const first = board.listTasks(admin, {});
      expect(first.items).toHaveLength(maxPageSize ?? 3);
      expect(board.listTasks(admin, { limit: 3 })).toEqual(first);
      const limited = board.listTasks(admin, { limit: 1 });
      expect(limited.items).toEqual(first.items.slice(0, 1));
      const remaining = board.listTasks(admin, { cursor: limited.nextCursor! });
      expect(remaining.items).toHaveLength(2);
      expect(remaining.nextCursor).toBeNull();
      if (maxPageSize === undefined) {
        expect(first.nextCursor).toBeNull();
        expect([...limited.items, ...remaining.items]).toEqual(first.items);
      } else {
        expect(first.nextCursor).not.toBeNull();
        const last = board.listTasks(admin, { cursor: first.nextCursor! });
        expect(last.items).toEqual(remaining.items.slice(1));
        expect(last.nextCursor).toBeNull();
      }
      expect(board.listTasks(admin, { status: "done" })).toEqual({
        items: [],
        nextCursor: null,
      });
    },
  );

  it("validates config before opening the database", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({ maxPageSize: 0 }),
    );
    expect(() => createBoard({ dataDir: directory })).toThrow();
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({ unknown: true }),
    );
    expect(() => createBoard({ dataDir: directory })).toThrow();
  });
});
