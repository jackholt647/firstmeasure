export class PricebookError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, statusCode: number, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "PricebookError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function badRequest(code: string, message?: string, details?: unknown) {
  return new PricebookError(code, 400, message, details);
}

export function notFound(code: string, message?: string, details?: unknown) {
  return new PricebookError(code, 404, message, details);
}

export function conflict(code: string, message?: string, details?: unknown) {
  return new PricebookError(code, 409, message, details);
}
