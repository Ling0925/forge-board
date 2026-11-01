import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactContentSchema,
  assertTransition,
  errorStatuses,
  mayAssign,
  mayReclaim,
  needsApproval,
  principalSchema,
  projectSettingsSchema,
  scopeSchema,
  settingsSchema,
  statusSchema,
  taskSchema,
  transitions,
} from "../src/domain/index.js";
import { expectCode, fixture } from "./helpers.js";

describe("domain contracts", () => {
  it("validates every allowed transition and rejects every other pair", () => {
    for (const from of statusSchema.options)
      for (const to of statusSchema.options) {
        if (transitions[from].includes(to))
          expect(() => assertTransition(from, to)).not.toThrow();
        else expectCode(() => assertTransition(from, to), "invalid_transition");
      }
    for (const terminal of ["done", "failed", "canceled"] as const)
      expect(transitions[terminal]).toEqual(["todo"]);
  });

  it("matches exact and wildcard approval rules", () => {
    const settings = projectSettingsSchema.parse({
      approvalRequired: ["in_review->done", "*->canceled"],
    });
    expect(needsApproval(settings, "in_review", "done")).toBe(true);
    expect(needsApproval(settings, "todo", "canceled")).toBe(true);
    expect(needsApproval(settings, "todo", "in_progress")).toBe(false);
    expect(needsApproval({}, "in_review", "done")).toBe(false);
    expect(() =>
      projectSettingsSchema.parse({ approvalRequired: ["nonsense"] }),
    ).toThrow();
  });

  it("has no default expiry, retention, or page cap and exposes JSON schemas", () => {
    expect(projectSettingsSchema.parse({})).toEqual({});
    expect(settingsSchema.parse({})).toEqual({});
    expect(z.toJSONSchema(taskSchema).type).toBe("object");
    expect(
      z.toJSONSchema(settingsSchema).properties?.maxPageSize,
    ).toMatchObject({ description: "bounds one response's memory" });
    expect(scopeSchema.options).toHaveLength(7);
  });

  it("requires an owner for agents and exactly one artifact content representation", () => {
    const { agent } = fixture();
    expect(() =>
      principalSchema.parse({ ...agent.principal, owner: null }),
    ).toThrow();
    expect(() =>
      artifactContentSchema.parse({ uri: "file:///out", text: "duplicate" }),
    ).toThrow();
    expect(() =>
      artifactContentSchema.parse({ uri: null, text: null }),
    ).toThrow();
  });

  it("defines human oversight and same-owner assignment without agent escalation", () => {
    const { admin, owner, other, agent, peer, foreignAgent, task } = fixture();
    expect(mayAssign(agent.principal, agent.principal, {})).toBe(true);
    expect(mayAssign(agent.principal, peer.principal, {})).toBe(false);
    expect(
      mayAssign(agent.principal, peer.principal, {
        allowAgentAssignment: true,
      }),
    ).toBe(true);
    expect(
      mayAssign(agent.principal, foreignAgent.principal, {
        allowAgentAssignment: true,
      }),
    ).toBe(false);
    expect(
      mayAssign(agent.principal, owner.principal, {
        allowAgentAssignment: true,
      }),
    ).toBe(false);
    expect(mayAssign(owner.principal, foreignAgent.principal, {})).toBe(true);
    const item = task();
    expect(mayReclaim(owner.principal, item, agent.principal, false)).toBe(
      true,
    );
    expect(mayReclaim(other.principal, item, agent.principal, false)).toBe(
      false,
    );
    expect(mayReclaim(admin.principal, item, agent.principal, true)).toBe(true);
    expect(mayReclaim(agent.principal, item, agent.principal, true)).toBe(
      false,
    );
  });

  it("keeps stable error codes and transport-neutral status mapping", () => {
    expect(errorStatuses).toEqual({
      validation_error: 422,
      not_found: 404,
      forbidden: 403,
      unauthorized: 401,
      conflict: 409,
      claim_conflict: 409,
      lease_lost: 409,
      version_mismatch: 412,
      cycle: 409,
      invalid_transition: 409,
      idempotency_mismatch: 422,
      approval_required: 409,
    });
  });
});
