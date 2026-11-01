import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectCode, fixture } from "./helpers.js";

describe("principals and tokens", () => {
  it("compares token expiry instants independently of ISO fractional precision", () => {
    const { board, admin, agent, now, advance, task } = fixture();
    const item = task();
    const token = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: ["tasks:read"],
      expiresAt: new Date(now() + 1000).toISOString().replace(".000Z", "Z"),
    });
    const actor = board.verifyToken(token.secret!);
    advance(1000);
    expectCode(() => board.verifyToken(token.secret!), "unauthorized");
    expectCode(() => board.getTask(actor, item.id), "unauthorized");
  });
  it("creates humans and owned agents, lists them, and forbids agent owners", () => {
    const { board, admin, owner, agent } = fixture();
    expect(agent.principal.owner).toBe(owner.principal.id);
    expectCode(
      () =>
        board.createPrincipal(admin, {
          kind: "agent",
          name: "Nested",
          owner: agent.principal.id,
        }),
      "forbidden",
    );
    expect(board.listPrincipals(admin, { limit: 100 }).items).toContainEqual(
      agent.principal,
    );
    expectCode(() => board.listPrincipals(agent, { limit: 100 }), "forbidden");
  });

  it("returns a random secret once, stores sha256 only, verifies scopes, and records usage", () => {
    const { board, repo, admin, agent, project } = fixture();
    const input = {
      principalId: agent.principal.id,
      scopes: ["tasks:read", "tasks:claim"] as const,
      projectIds: [project.id],
    };
    const token = board.createToken(
      admin,
      { ...input, scopes: [...input.scopes] },
      { idempotencyKey: "token" },
    );
    const second = board.createToken(admin, {
      ...input,
      scopes: [...input.scopes],
    });
    expect(token.secret).not.toBe(second.secret);
    expect(token.token).not.toHaveProperty("hash");
    const stored = repo.get("tokens", token.token.id)!;
    expect(stored.hash).toBe(
      createHash("sha256").update(token.secret!).digest("hex"),
    );
    expect(
      JSON.stringify(repo.replay(admin.principal.id, "token")),
    ).not.toContain(token.secret);
    expect(
      board.createToken(
        admin,
        { ...input, scopes: [...input.scopes] },
        { idempotencyKey: "token" },
      ),
    ).toEqual({ token: token.token, secret: null });
    const actor = board.verifyToken(token.secret!);
    expect(actor).toMatchObject({
      principal: agent.principal,
      scopes: input.scopes,
      projectIds: [project.id],
      tokenId: token.token.id,
    });
    expect(repo.get("tokens", token.token.id)?.lastUsedAt).not.toBeNull();
    expect(
      board
        .listTokens(admin, { limit: 100 })
        .items.every((value) => !("hash" in value)),
    ).toBe(true);
    expectCode(() => board.verifyToken("incorrect"), "unauthorized");
  });

  it("honors creator-selected expiration and has no default token expiry", () => {
    const { board, admin, agent, now, advance } = fixture();
    const expiring = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: [],
      expiresAt: new Date(now() + 1000).toISOString(),
    });
    const permanent = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: [],
    });
    board.verifyToken(expiring.secret!);
    advance(1000);
    expectCode(() => board.verifyToken(expiring.secret!), "unauthorized");
    advance(1000 * 60 * 60 * 24 * 365);
    expect(board.verifyToken(permanent.secret!).principal.id).toBe(
      agent.principal.id,
    );
  });

  it("invalidates both tokens and already-authenticated actors on revocation or disable", () => {
    const { board, admin, agent, task } = fixture();
    const item = task();
    const token = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: ["tasks:read"],
    });
    const actor = board.verifyToken(token.secret!);
    board.revokeToken(admin, token.token.id);
    expectCode(() => board.verifyToken(token.secret!), "unauthorized");
    expectCode(() => board.getTask(actor, item.id), "unauthorized");
    const other = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: ["tasks:read"],
    });
    board.disablePrincipal(admin, agent.principal.id);
    expectCode(() => board.verifyToken(other.secret!), "unauthorized");
    expectCode(() => board.getTask(agent, item.id), "unauthorized");
  });

  it("enforces operation scopes, task project scope, and filtered lists", () => {
    const { board, admin, agent, project, task } = fixture();
    const item = task();
    const other = board.createProject(admin, { key: "OTHER", name: "Other" });
    const limited = { ...agent, projectIds: [other.id] };
    expectCode(() => board.getTask(limited, item.id), "forbidden");
    expectCode(() => board.claim(limited, item.id), "forbidden");
    expectCode(() => board.getProject(limited, project.id), "forbidden");
    expect(board.listTasks(limited, { limit: 100 }).items).toEqual([]);
    expect(
      board
        .listProjects(limited, { limit: 100 })
        .items.map((value) => value.id),
    ).toEqual([other.id]);
    expect(
      board
        .listEvents(limited, { limit: 100 })
        .items.every((event) => event.projectId === other.id),
    ).toBe(true);
    expectCode(
      () =>
        board.updateTask(
          { ...agent, scopes: ["tasks:read"] },
          item.id,
          { title: "No" },
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    expectCode(
      () =>
        board.createPrincipal(
          { ...admin, projectIds: [project.id] },
          { kind: "human", name: "No" },
        ),
      "forbidden",
    );
  });

  it("prevents project-bound token administration from expanding or accessing other projects", () => {
    const { board, admin, project, agent } = fixture();
    const limited = { ...admin, projectIds: [project.id] };
    expectCode(
      () =>
        board.createToken(limited, {
          principalId: agent.principal.id,
          scopes: [],
        }),
      "forbidden",
    );
    const unrestricted = board.createToken(admin, {
      principalId: agent.principal.id,
      scopes: [],
    });
    expectCode(
      () => board.revokeToken(limited, unrestricted.token.id),
      "forbidden",
    );
    const local = board.createToken(limited, {
      principalId: agent.principal.id,
      scopes: ["tasks:read"],
      projectIds: [project.id],
    });
    expect(
      board.listTokens(limited, { limit: 100 }).items.map((token) => token.id),
    ).toEqual([local.token.id]);
  });
});
