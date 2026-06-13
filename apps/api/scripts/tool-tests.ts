// CLI for the orchestrator tool-call test harness. Drives the dev API endpoint
// (POST /api/v1/dev/tool-tests/run) and pretty-prints the report.
//
//   pnpm --filter @popcorn/api test:tools -- --list
//   pnpm --filter @popcorn/api test:tools -- --tool create_or_load_brief
//   pnpm --filter @popcorn/api test:tools -- --tool plan_shots --provider anthropic
//   pnpm --filter @popcorn/api test:tools -- --tool create_or_load_brief --keep
//
// The dev API must be running with the harness enabled, e.g.:
//   NODE_ENV=development AUTH_MODE=local ENABLE_TOOL_TEST_HARNESS=1 pnpm dev:api

interface CliOptions {
  tool?: string;
  case?: string;
  provider?: string;
  url: string;
  keep: boolean;
  list: boolean;
}

function defaultBaseUrl(): string {
  const port = process.env.PORT || "4000";
  return `http://localhost:${port}`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: process.env.TOOL_TEST_URL || defaultBaseUrl(),
    keep: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--list":
        options.list = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--tool":
        options.tool = next;
        i += 1;
        break;
      case "--case":
        options.case = next;
        i += 1;
        break;
      case "--provider":
        options.provider = next;
        i += 1;
        break;
      case "--url":
        options.url = next ?? options.url;
        i += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @popcorn/api test:tools -- [options]

Options:
  --list                 List batteries and which tools are wired, then exit.
  --tool <name>          Run only this tool's battery.
  --case <name>          Run only the case with this exact name.
  --provider <p>         openai | anthropic | configured (default).
  --keep                 Skip sandbox teardown (returns workspace/project ids).
  --url <base>           API base URL (default http://localhost:$PORT).

Requires the dev API running with ENABLE_TOOL_TEST_HARNESS=1.`);
}

interface AssertionResult {
  label: string;
  ok: boolean;
  detail?: string;
}
interface CaseResult {
  tool: string;
  case: string;
  status: "passed" | "failed" | "skipped" | "error";
  model?: string;
  toolCalled?: string | null;
  actualInput?: unknown;
  resultStatus?: string;
  assertions: AssertionResult[];
  errorMessage?: string;
  sandbox?: { workspaceId: string; projectId: string } | null;
}
interface Report {
  provider: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  results: CaseResult[];
}

const ICON: Record<CaseResult["status"], string> = {
  passed: "✓",
  failed: "✗",
  skipped: "·",
  error: "!",
};

async function listBatteries(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/dev/tool-tests`);
  if (!res.ok) throw new Error(await describeHttpError(res));
  const body = (await res.json()) as {
    batteries: {
      tool: string;
      wired: boolean;
      cases: { name: string; status: string }[];
    }[];
  };
  for (const battery of body.batteries) {
    console.log(`${battery.wired ? "●" : "○"} ${battery.tool}${battery.wired ? "" : "  (not wired)"}`);
    for (const testCase of battery.cases) {
      console.log(`    [${testCase.status}] ${testCase.name}`);
    }
  }
}

async function runSuite(options: CliOptions): Promise<void> {
  const res = await fetch(`${options.url}/api/v1/dev/tool-tests/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool: options.tool,
      case: options.case,
      provider: options.provider,
      keepArtifacts: options.keep,
    }),
  });
  if (!res.ok) throw new Error(await describeHttpError(res));
  const report = (await res.json()) as Report;

  for (const result of report.results) {
    console.log(
      `\n${ICON[result.status]} ${result.tool} :: ${result.case}` +
        `${result.toolCalled ? `  → ${result.toolCalled}` : ""}` +
        `${result.model ? `  [${result.model}]` : ""}`
    );
    if (result.errorMessage) {
      console.log(`    error: ${result.errorMessage}`);
    }
    for (const assertion of result.assertions) {
      console.log(
        `    ${assertion.ok ? "✓" : "✗"} ${assertion.label}` +
          `${assertion.detail && assertion.detail !== "ok" ? ` — ${assertion.detail}` : ""}`
      );
    }
    if (result.actualInput !== undefined) {
      console.log(`    input: ${JSON.stringify(result.actualInput)}`);
    }
    if (result.sandbox) {
      console.log(
        `    kept: workspace=${result.sandbox.workspaceId} project=${result.sandbox.projectId}`
      );
    }
  }

  console.log(
    `\nprovider=${report.provider}  total=${report.total}  ` +
      `passed=${report.passed}  failed=${report.failed}  ` +
      `skipped=${report.skipped}  errored=${report.errored}`
  );

  if (report.failed > 0 || report.errored > 0) {
    process.exitCode = 1;
  }
}

async function describeHttpError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = JSON.stringify(await res.json());
  } catch {
    detail = await res.text();
  }
  return `HTTP ${res.status} ${res.statusText}: ${detail}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    await listBatteries(options.url);
    return;
  }
  await runSuite(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
