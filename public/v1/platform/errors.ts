export class PlatformError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, statusCode: number, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "PlatformError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function badRequest(code: string, message?: string, details?: unknown) {
  return new PlatformError(code, 400, message, details);
}

export function notFound(code: string, message?: string, details?: unknown) {
  return new PlatformError(code, 404, message, details);
}

export function conflict(code: string, message?: string, details?: unknown) {
  return new PlatformError(code, 409, message, details);
}

export function unauthorized(code: string, message?: string, details?: unknown) {
  return new PlatformError(code, 401, message, details);
}

export function forbidden(code: string, message?: string, details?: unknown) {
  return new PlatformError(code, 403, message, details);
}
