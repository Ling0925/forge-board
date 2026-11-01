import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBoard } from "../src/service/index.js";
import {
  createRepository,
  openDatabase,
  transaction,
} from "../src/store/index.js";
import { fixture, temporaryDirectory } from "./helpers.js";

describe("SQLite store", () => {
  it("enables WAL and foreign keys, applies migrations once, and includes workspace_id on every table", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "board.sqlite");
    const db = openDatabase(path);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({
      foreign_keys: 1,
    });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    for (const { name } of tables)
      expect(
        db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => column.name),
      ).toContain("workspace_id");
    const migrations = db.prepare("SELECT * FROM schema_migrations").all();
    db.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare("SELECT * FROM schema_migrations").all()).toEqual(
      migrations,
    );
    expect(reopened.prepare("SELECT * FROM workspaces").all()).toHaveLength(1);
    reopened.close();
  });

  it("rolls back state and its event together", () => {
    const { db, repo, admin } = fixture();
    const before = repo.events(0);
    expect(() =>
      transaction(db, () => {
        repo.insert("projects", {
          id: "prj_rollback",
          workspaceId: "default",
          key: "ROLLBACK",
          name: "Rollback",
          settings: {},
        });
        repo.event({
          workspaceId: "default",
          projectId: "prj_rollback",
          taskId: null,
          type: "project_created",
          actor: admin.principal.id,
          owner: null,
          data: {},
          at: "2026-11-01T00:00:00.000Z",
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(repo.get("projects", "prj_rollback")).toBeUndefined();
    expect(repo.events(0)).toEqual(before);
  });

  it("rejects dangling references", () => {
    const { repo, project, task } = fixture();
    const item = task();
    expect(() =>
      repo.insert("dependencies", {
        id: "dep_missing",
        workspaceId: "default",
        taskId: item.id,
        dependsOnId: "missing",
      }),
    ).toThrow();
    expect(() =>
      repo.insert("labels", {
        id: "lbl_missing",
        workspaceId: "missing",
        projectId: project.id,
        name: "broken",
      }),
    ).toThrow();
  });

  it("persists data and reopens a board using the built-in migration path", () => {
    const { directory, admin, task, now } = fixture({}, {});
    const item = task();
    const reopened = createBoard({ dataDir: directory!, now });
    expect(reopened.getTask(admin, item.id)).toEqual(item);
    reopened.close();
  });

  it("exposes repositories for local first-principal provisioning", () => {
    const db = openDatabase(":memory:");
    const repo = createRepository(db);
    const principal = repo.insert("principals", {
      id: "usr_initial",
      workspaceId: "default",
      kind: "human",
      owner: null,
      name: "Initial",
      disabled: false,
    });
    const board = createBoard({ db });
    const token = board.createToken(
      { principal, scopes: ["tokens:admin"], projectIds: null },
      { principalId: principal.id, scopes: ["tokens:admin"] },
    );
    expect(board.verifyToken(token.secret!).principal).toEqual(principal);
    board.close();
    expect(repo.get("principals", principal.id)).toEqual(principal);
    db.close();
  });
});
