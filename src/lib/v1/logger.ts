// Structured JSON-line logger for /api/v1.
//
// Operator goals: every log line carries the correlation IDs needed to trace a
// generation across HTTP request, job, and provider call boundaries. Lifecycle
// events include durationMs so slow steps are visible without a separate
// metrics pipeline. Provider errors should be passed through redact.ts before
// being attached to a log record.
//
// runId, stageId, and itemId are accepted today so the generation-run model
// from the rest of this scope can attach them without changing log callsites.

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  requestId?: string;
  workspaceId?: string;
  projectId?: string;
  runId?: string;
  stageId?: string;
  itemId?: string;
  jobId?: string;
  jobType?: string;
  provider?: string;
}

export type LogFields = LogContext & {
  durationMs?: number;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
};

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(context: LogContext): Logger;
}

function effectiveLevel(): LogLevel | null {
  const raw = (process.env.AIVIDI_LOG_LEVEL || "").toLowerCase();
  if (raw === "silent") return null;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
};

let sink: LogSink = defaultSink;

export function setLogSink(custom: LogSink | null): void {
  sink = custom || defaultSink;
}

function emit(
  level: LogLevel,
  base: LogContext,
  event: string,
  fields?: LogFields
): void {
  const min = effectiveLevel();
  if (min === null) return;
  if (LEVEL_RANK[level] < LEVEL_RANK[min]) return;

  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    ...base,
    ...(fields || {}),
    event,
  };

  try {
    sink(JSON.stringify(record), level);
  } catch {
    // Logging must never throw.
  }
}

function build(base: LogContext): Logger {
  return {
    debug(event, fields) {
      emit("debug", base, event, fields);
    },
    info(event, fields) {
      emit("info", base, event, fields);
    },
    warn(event, fields) {
      emit("warn", base, event, fields);
    },
    error(event, fields) {
      emit("error", base, event, fields);
    },
    child(context) {
      return build({ ...base, ...context });
    },
  };
}

export function createLogger(context: LogContext = {}): Logger {
  return build(context);
}

export const rootLogger = createLogger();
