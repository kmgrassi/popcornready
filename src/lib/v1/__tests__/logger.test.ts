import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, setLogSink } from "../logger";

type Captured = { line: string; level: string };

function captureSink(): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  setLogSink((line, level) => captured.push({ line, level }));
  return {
    captured,
    restore: () => setLogSink(null),
  };
}

test("emits structured JSON with correlation fields", () => {
  const { captured, restore } = captureSink();
  try {
    const log = createLogger({
      requestId: "req_1",
      projectId: "proj_1",
      jobId: "job_1",
      jobType: "generation",
    });
    log.info("job.created", { provider: "anthropic" });

    assert.equal(captured.length, 1);
    const record = JSON.parse(captured[0].line);
    assert.equal(record.event, "job.created");
    assert.equal(record.requestId, "req_1");
    assert.equal(record.projectId, "proj_1");
    assert.equal(record.jobId, "job_1");
    assert.equal(record.jobType, "generation");
    assert.equal(record.provider, "anthropic");
    assert.equal(record.level, "info");
    assert.ok(record.timestamp, "timestamp is set");
  } finally {
    restore();
  }
});

test("child logger inherits context and overrides fields", () => {
  const { captured, restore } = captureSink();
  try {
    const root = createLogger({ requestId: "req_1", projectId: "proj_1" });
    const child = root.child({ jobId: "job_99", projectId: "proj_override" });
    child.info("step.started", { step: "planning" });

    const record = JSON.parse(captured[0].line);
    assert.equal(record.requestId, "req_1");
    assert.equal(record.projectId, "proj_override");
    assert.equal(record.jobId, "job_99");
    assert.equal(record.step, "planning");
  } finally {
    restore();
  }
});

test("silent log level suppresses all output", () => {
  const { captured, restore } = captureSink();
  const previousLevel = process.env.AIVIDI_LOG_LEVEL;
  process.env.AIVIDI_LOG_LEVEL = "silent";
  try {
    const log = createLogger();
    log.info("ignored");
    log.error("ignored");
    assert.equal(captured.length, 0);
  } finally {
    if (previousLevel === undefined) delete process.env.AIVIDI_LOG_LEVEL;
    else process.env.AIVIDI_LOG_LEVEL = previousLevel;
    restore();
  }
});

test("event arg is the source of truth even if fields includes it", () => {
  const { captured, restore } = captureSink();
  try {
    const log = createLogger();
    log.info("real.event", { event: "fields.event" } as never);
    const record = JSON.parse(captured[0].line);
    assert.equal(record.event, "real.event");
  } finally {
    restore();
  }
});
