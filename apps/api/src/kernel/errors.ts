/**
 * One error type crossing every boundary, carrying the HTTP status it should
 * become.
 *
 * This lives in the kernel rather than the HTTP adapter deliberately: the
 * domain needs to say "that is a conflict" without knowing what a response is.
 * Mapping the status onto an actual reply is the driving adapter's job.
 */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  static notFound(what: string, id?: string): AppError {
    return new AppError("not_found", id ? `${what} ${id} not found` : `${what} not found`);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError("conflict", message, details);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError("bad_request", message, details);
  }

  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError("unprocessable", message, details);
  }

  static internal(message: string, details?: unknown): AppError {
    return new AppError("internal", message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** A 4xx will fail identically on every retry, so a worker must not retry it. */
export function isPermanent(err: unknown): boolean {
  return isAppError(err) && err.status >= 400 && err.status < 500;
}

export function serialiseError(err: unknown): Record<string, unknown> {
  if (isAppError(err)) {
    return { code: err.code, message: err.message, details: err.details ?? null };
  }
  if (err instanceof Error) {
    return { code: "internal", message: err.message, stack: err.stack ?? null };
  }
  return { code: "internal", message: String(err) };
}
