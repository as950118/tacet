export { buildProgram } from "./program.js";
export { TacetWorkspace, DEFAULT_INDEX_PATH } from "./workspace.js";
export type {
  AnalyzeBackendOptions,
  CheckOptions,
  DiffBackendOptions,
  GitChangeReport,
  ExtractBackendOptions,
  ExtractBackendResult,
  IndexFrontendOptions,
  IndexFrontendResult,
  OntologyQueryOptions,
  VerifiedGitChangeReport,
  VerifyChangesOptions,
} from "./workspace.js";
export { createAiProvider, AI_PROVIDERS } from "./ai.js";
export type { AiProviderName, CreateAiProviderOptions } from "./ai.js";
export { changedSourceFiles } from "./git.js";
export * from "./format.js";
export { runCi } from "./ci.js";
export type { CiOptions, CiResult, CheckFailOn, ImpactFailOn, VerifyFailOn } from "./ci.js";
