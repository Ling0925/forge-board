export const errorStatuses = {
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
} as const;

export type ErrorCode = keyof typeof errorStatuses;

export class BoardError extends Error {
  readonly status: (typeof errorStatuses)[ErrorCode];

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "BoardError";
    this.status = errorStatuses[code];
  }
}
