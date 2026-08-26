export class CodeReportError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CodeReportError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new CodeReportError(400, "bad_request", message, details);
}

export function notFound(message: string, details?: unknown) {
  return new CodeReportError(404, "not_found", message, details);
}
