// The registry bridge is production infrastructure (the orchestrator engine is
// its real consumer), so it lives in lib/orchestrator-tools. The harness re-exports
// it. For the "all" selection-test mode, pass { includeStubs: true } to also expose
// the unimplemented vocabulary as driver stubs.
export {
  toOrchestratorRegistry,
  type ToOrchestratorRegistryOptions,
  type ToOrchestratorRegistryOptions as BridgeOptions,
} from "@/lib/orchestrator-tools/to-orchestrator-registry";
