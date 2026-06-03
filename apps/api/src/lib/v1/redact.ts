// Provider-error redaction.
//
// Raw provider error messages can contain Authorization headers, API keys, or
// JWTs (especially when an upstream echoes our request back inside its error
// payload). PR9 requires that the run API never stores or returns those to the
// browser, so every error we surface from a provider call must pass through
// here first.
//
// Patterns intentionally err on the side of false positives — any token-shaped
// string near a sensitive key name is replaced with [REDACTED]. We also cap
// message length so a multi-megabyte upstream error body cannot poison a job
// record.

const REDACTED = "[REDACTED]";
const MAX_MESSAGE_LENGTH = 500;

// Each pattern either matches the full secret (and is replaced wholesale) or
// uses a capture group for the secret portion adjacent to a sensitive key.
const TOKEN_PATTERNS: RegExp[] = [
  // OpenAI-shaped secret keys.
  /sk-[A-Za-z0-9_-]{16,}/g,
  // Google API keys.
  /AIza[0-9A-Za-z_-]{20,}/g,
  // Bearer tokens in headers / messages.
  /Bearer\s+[A-Za-z0-9._\-+/]{16,}=*/gi,
  // JWT-shaped tokens.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

// Key=value style redactions: the value next to a sensitive key gets scrubbed
// even if it does not match the standalone token patterns above.
const KEYED_VALUE_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
  /(x[-_]?api[-_]?key\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
  /(xi[-_]?api[-_]?key\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
  /(api[-_]?key\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
  /("?(?:api[_-]?key|access[_-]?token|secret|password)"?\s*:\s*["'])([^"']+)/gi,
];

function scrub(message: string): string {
  let out = message;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of KEYED_VALUE_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  return out;
}

function truncate(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, Math.max(1, maxLength - 1))}…`;
}

export interface RedactedError {
  code: string;
  message: string;
}

export interface RedactErrorOptions {
  defaultCode?: string;
  maxLength?: number;
}

export function redactMessage(
  message: string,
  maxLength = MAX_MESSAGE_LENGTH
): string {
  return truncate(scrub(message), maxLength);
}

export function redactError(
  err: unknown,
  options: RedactErrorOptions = {}
): RedactedError {
  const defaultCode = options.defaultCode || "internal_error";
  const maxLength = options.maxLength ?? MAX_MESSAGE_LENGTH;

  if (err instanceof Error) {
    const codeValue =
      "code" in err ? (err as { code?: unknown }).code : undefined;
    const code = typeof codeValue === "string" ? codeValue : defaultCode;
    return {
      code,
      message: redactMessage(err.message || "Unknown error.", maxLength),
    };
  }
  if (typeof err === "string") {
    return { code: defaultCode, message: redactMessage(err, maxLength) };
  }
  if (err && typeof err === "object") {
    try {
      return {
        code: defaultCode,
        message: redactMessage(JSON.stringify(err), maxLength),
      };
    } catch {
      return { code: defaultCode, message: "Unserializable error." };
    }
  }
  return { code: defaultCode, message: "Unknown error." };
}
