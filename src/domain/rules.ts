import { BoardError } from "./errors.js";
import type { Principal, ProjectSettings, Status, Task } from "./schemas.js";

export const transitions: Record<Status, readonly Status[]> = {
  todo: ["in_progress", "input_required", "canceled"],
  in_progress: [
    "todo",
    "input_required",
    "blocked",
    "in_review",
    "failed",
    "canceled",
  ],
  input_required: ["todo", "in_progress", "blocked", "canceled"],
  blocked: ["todo", "in_progress", "input_required", "canceled"],
  in_review: ["todo", "in_progress", "input_required", "done", "canceled"],
  done: ["todo"],
  failed: ["todo"],
  canceled: ["todo"],
};

export function assertTransition(from: Status, to: Status): void {
  if (!transitions[from].includes(to)) {
    throw new BoardError(
      "invalid_transition",
      `Cannot transition ${from} to ${to}`,
    );
  }
}

export function needsApproval(
  settings: ProjectSettings,
  from: Status,
  to: Status,
): boolean {
  return (
    settings.approvalRequired?.some(
      (rule) => rule === `${from}->${to}` || rule === `*->${to}`,
    ) ?? false
  );
}

export function mayAssign(
  actor: Principal,
  target: Principal | null,
  settings: ProjectSettings,
): boolean {
  if (actor.kind === "human") return true;
  if (target?.id === actor.id) return true;
  return (
    settings.allowAgentAssignment === true &&
    target?.kind === "agent" &&
    target.owner === actor.owner
  );
}

export function mayReclaim(
  actor: Principal,
  task: Task,
  holder: Principal,
  projectAdmin: boolean,
): boolean {
  return (
    actor.kind === "human" &&
    (projectAdmin || actor.id === task.accountable || actor.id === holder.owner)
  );
}

export function isTerminal(status: Status): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}
