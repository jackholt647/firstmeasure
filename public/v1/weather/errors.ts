export class WeatherError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WeatherError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new WeatherError(400, "bad_request", message, details);
}

export function upstreamUnavailable(message: string, details?: unknown) {
  return new WeatherError(502, "upstream_unavailable", message, details);
}
