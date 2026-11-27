// site-to-api: parse any site into a typed API.
export * from "./types.js";
export {
  buildSiteModel,
  INFERENCE_VERSION,
  STAGES,
  type BuildOptions,
  type BuildResult,
  type Stage,
} from "./pipeline.js";
export { isStaleModel, loadCurrentModel } from "./model-refresh.js";
export {
  loadCapture,
  parseCapture,
  mergeCaptures,
  fromHar,
  fromMitmproxy,
  encodeTnetstring,
} from "./load/index.js";
export { firstCallLine } from "./call-line.js";
export { filterExchanges, learnNoise, type FilterOptions } from "./filter.js";
export {
  inputParams,
  documentedParams,
  isDerived,
  bodyInputs,
  graphqlInputs,
  operationInputs,
} from "./params.js";
export {
  COOKIE_XSRF_HEADERS,
  SESSION_LIVE_HEADER,
  SESSION_SECRET_HEADER,
  cookieXsrfHeaders,
  isSessionSecretHeader,
  withoutSessionValues,
} from "./session-headers.js";
export { inferSchema } from "./infer/schema.js";
export { templatePaths } from "./infer/templates.js";
export { builtinAbilities, builtinSites } from "./builtin-abilities.js";
export { hostsNamed, matchAbilities, scoreAbility, type AbilityMatch } from "./match.js";
export { abilityPlan, type AbilityPlan } from "./ability-plan.js";
export { detectCapabilities, capabilityIndex } from "./infer/capabilities.js";
export {
  clearTransportPreferences,
  readTransportPreference,
  readTransportPreferences,
  recordTransportPreference,
  type TransportName,
  type TransportNote,
} from "./transport-preference.js";
export {
  siteCapabilities,
  withWebMcp,
  type SiteCapabilities,
  type SiteAbilitySummary,
  type SiteOperationSummary,
} from "./site-capabilities.js";
export {
  ABILITY_HISTORY_LIMIT,
  abilityVersionNumber,
  countAbilityVersions,
  versionLabel,
  listAbilityVersions,
  readAbilityVersion,
  saveAbilityVersion,
  versionChangedAbility,
  versionStamp,
  type AbilityVersion,
} from "./ability-versions.js";
export { restoreAbility, type RestoreAbilityOptions } from "./ability-restore.js";
export { abilityHostFor, type AbilityHostOptions } from "./ability-host.js";
export { checkAbilityInputs } from "./ability-inputs.js";
export {
  formatFinding,
  lintPublicAbility,
  publicAbility,
  publishErrors,
  type PublicAbility,
  type PublishFinding,
  type PublishSeverity,
} from "./ability-publish.js";
export {
  parseReview,
  reviewPrompt,
  reviewSystem,
  REVIEW_MODEL,
  type AbilityReview,
  type ReviewFinding,
} from "./ability-review.js";
export {
  abilityContent,
  contentDigest,
  digestOf,
  normalizedCode,
  testedAbility,
  untestedWays,
  wayDigest,
  withTested,
  type AbilityTested,
} from "./ability-digest.js";
export {
  abilityDirectory,
  abilitySlug,
  createAbility,
  listAbilities,
  maintainAbilities,
  readAbility,
  readSiteFacts,
  readSiteNotes,
  renderSiteNotes,
  runAbility,
  saveSiteNote,
  saveAbility,
  testAbility,
  trashAbility,
  writeSiteNotes,
  type SiteNote,
  type AbilityRunOptions,
  type SaveAbilityOptions,
  type Ability,
  type AbilityCreatedBy,
  type AbilityHost,
  type AbilityKind,
  type AbilityOptions,
  type AbilityPrecondition,
  type AbilityPostcondition,
  type AbilityRunResult,
  type AbilityStats,
  type AbilityVia,
  type AbilityWayStats,
  type AbilityWay,
  type AbilityWayApi,
  type AbilityWayExpect,
  type AbilityReference,
  type AbilityWayPage,
  type AbilityWayScript,
  type AbilityWaySteps,
} from "./abilities.js";
export {
  shapeOf,
  expectedShape,
  shapeDrift,
  unusableAnswer,
  type AnswerShape,
} from "./ability-shape.js";
export {
  deriveResultAsserts,
  resultMismatch,
  withResultAsserts,
  type AbilityAssert,
} from "./ability-assert.js";
export {
  inferAbilityInputs,
  type AbilityDemonstration,
  type AbilityTypedValue,
  type InferredAbility,
} from "./ability-infer.js";
export { scrubAbility, type AbilityScrub, type ScrubMark } from "./ability-scrub.js";
export { abilityWrites, type AbilityWrite, type AbilityWriteKind } from "./ability-effects.js";
export {
  buildAbility,
  type BlockedReason,
  type BuildOptions as AbilityBuildOptions,
  type BuildResult as AbilityBuildResult,
} from "./build.js";
export { pageRows, type AbilityCheck, type AbilityPage } from "./ability-records.js";
export {
  AbilityWriteError,
  type OutcomeCode,
  type ReadBack,
  type RetryClass,
  type WriteOutcome,
  type WriteStatus,
} from "./ability-writes.js";
export type { AbilityTest, AbilityTestReport } from "./ability-contract.js";
export { abilityNeeds, wayNeeds, missingNeeds, type AbilityNeed } from "./ability-needs.js";
export {
  abilityFromAction,
  abilityFromRecipe,
  abilityFromSkill,
  abilityFromTool,
  abilityFromWorkflow,
  importPackAbilities,
  migrateAllAbilities,
  migrateSiteAbilities,
  type MigrationOptions,
  type MigrationReport,
  type MigrationSkill,
  type SiteMigrationReport,
  type Unmigrated,
} from "./abilities-migrate.js";
export { volatileFields, type VolatileField, type VolatileReason } from "./infer/volatile.js";
export { extractEmbedded } from "./infer/html.js";
export { toOpenApi, toAsyncApi } from "./emit/openapi.js";
export { toYaml } from "./emit/yaml.js";
export { generateClient } from "./emit/client.js";
export {
  generateStandaloneClient,
  operationDeclaration,
  provenWrite,
  type StandaloneClient,
} from "./emit/client-standalone.js";
export { generateDirectClient } from "./emit/standalone-client.js";
export { observations, type Observations } from "./emit/observations.js";
export {
  analyzeBundle,
  analyzeBundles,
  confirmCandidates,
  type BundleCandidate,
  type BundleGraph,
} from "./bundle-graph.js";
export {
  applyRebind,
  isHealableFailure,
  pathScore,
  proposeRebind,
  safeToReplay,
  trustedOrigin,
  type BundleHealKind,
  type BundleHealReceipt,
  type BundleRebind,
} from "./bundle-heal.js";
export {
  callWithBundleHeal,
  onBundleHealed,
  healOpFromBundle,
  resetBundleHealCache,
  type BundleHealDeps,
  type BundleHealOutcome,
} from "./bundle-heal-run.js";
export {
  decodeMap,
  decodeVlq,
  discoverMapUrl,
  mapUrlRefusal,
  originalPosition,
} from "./sourcemap.js";
export { sourceMaps, type SourceMapsResult } from "./sourcemap-read.js";
export { periodicEndpoints, withoutPeriodicSteps } from "./periodic.js";
export { emitFromHar, modelFromCapture, type HarEmit, type HarEmitResult } from "./har-emit.js";
export { serveMock, type MockServer } from "./mock-serve.js";
export { markdownReport, curlExample, redactedSamples } from "./emit/report.js";
export { htmlReport } from "./emit/html.js";
export { createRedactor } from "./redact.js";
export {
  exportSitePack,
  installSitePack,
  isSitePack,
  readSitePack,
  skillsForSite,
  PACK_FORMAT,
  PACK_VERSION,
  type PackBoost,
  type PackExport,
  type PackManifest,
  type PackSkill,
  type SitePack,
} from "./pack.js";
export { diffModels, formatDiff, schemaChanges } from "./diff.js";
export * from "./registry.js";
export { rebuild, importCaptures, saveRecording, loadFlows } from "./workflow.js";
export { RecordingSession, PassiveRecorder, type Recording, type RecordOptions } from "./record.js";
export { checkHealth, repair, readHealth, type HealthReport, type HealthResult } from "./health.js";
export { detectChallenge, type Challenge } from "./challenge.js";
export * from "./circuit-breaker.js";
export * from "./human-budget.js";
export * from "./why-broke.js";
export { coverage, type Suggestion } from "./coverage.js";
export { allowedHost, serve, type Server, type ServeOptions } from "./serve.js";
export { runMcpServer, siteTools, operationInputSchema } from "./mcp.js";
export * from "./output-schema.js";
export { catalogToolsForSite, searchCatalog, type CatalogTool } from "./catalog.js";
export {
  abilityEffect,
  effectAnnotations,
  inferEffect,
  isCallEffect,
  operationEffect,
  type CallEffect,
} from "./effect.js";
export { performFlow, editApi, nameOperations, type ModelLike } from "./agent.js";
export { explore, EXPLORE_BRIEF, type ExploreOptions, type ExploreResult } from "./explore.js";
export { watch, type WatchOptions, type WatchResult } from "./watch.js";
export * from "./recipes.js";
export {
  isSiteToolRequest,
  listSiteTools,
  readPageTool,
  readSiteTools,
  runSiteTool,
  setSiteToolsEnabled,
  siteToolSummaryFor,
  writeSiteTools,
  type SiteTool,
  type SiteToolFile,
  type SiteToolParam,
  type SiteToolParamType,
  type SiteToolSummary,
} from "./site-tools.js";
export { readLearned, learnAbout, learnedHint, type LearnedNote } from "./learned.js";
export {
  runRecipe,
  readFeed,
  RecipeError,
  RecipeSkip,
  resolveParams,
  resolveOperationInModel,
  type FeedResult,
  type RecipeHost,
  type RecipeRunOptions,
  type RecipeRunResult,
  type StrategyAttempt,
} from "./runtime/recipe.js";
export { browserRecipeHost, runSiteRecipe, type RecipeHostOptions } from "./runtime/recipe-host.js";
export { collectExpression, type CollectInput } from "./runtime/collect.js";
export { readDocs } from "./docs.js";
export { code, type SiteCodeOptions, type SiteCodeResult, type SiteCodeMatch } from "./code.js";
export {
  checkCaptures,
  exportSite,
  isSiteToolAction,
  runSiteToolAction,
  signingInfo,
  SITE_TOOL_ACTIONS,
  SITE_TOOL_HELP,
  type SiteToolAction,
  type SiteToolInput,
} from "./tool.js";
export {
  isSiteMapperRequest,
  handleSiteMapperRequest,
  type SiteMapperRequest,
} from "./requests.js";
export {
  learnLive,
  writeLive,
  undoLive,
  reversePairs,
  writeKind,
  harChallenge,
  learnBlocked,
  provenWrites,
  requestShape,
  NotProven,
  type LearnedOperation,
  type LiveLearnResult,
  type WriteKind,
} from "./live.js";
export {
  patternOf,
  rememberRun,
  structuralSignature,
  type ControlSeen,
  type PageSeen,
  type RunKnowledge,
} from "./site-knowledge.js";
export {
  compileRoute,
  contentWords,
  draftCell,
  hasSuccess,
  memoryLine,
  type CompileInput,
  type CompileOutcome,
} from "./route-compile.js";
export { inferSlots } from "./route-slots.js";
export { inputsFor, matchSavedRoute, sitesNamed, type RouteHit } from "./route-match.js";
export {
  cancelPending,
  combine,
  dropRoute,
  listRoutes,
  readRoute,
  settleRoutes,
  stageRun,
  type StageInput,
  type StageResult,
} from "./route-store.js";
export { apiWayFor, runnableWays, scriptWayFor, stepLine, wayProblem } from "./route-runnable.js";
export {
  abilityFromRoute,
  forgetAbility,
  promoteRoute,
  promotionReady,
  renameAbility,
  type Promotion,
} from "./route-promote.js";
export { reportWrong, type WrongReport } from "./route-wrong.js";
export { actRoute, dropActRoute, readActRoute, saveActRoute, type ActStep } from "./act-route.js";
export {
  HEAL_LOG_LIMIT,
  appendHealLog,
  readHealLog,
  type HealLogEntry,
  healLine,
  lastHeal,
  markHealPending,
  pendingHeal,
  queueHeal,
  readHealState,
  settleHeal,
  takeHealReceipt,
  type HealReceipt,
  type HealState,
  type PendingHeal,
} from "./ability-heal.js";
export { versionedSave, type VersionedSave } from "./ability-heal-receipt.js";
export {
  autoSaveAbility,
  autoSaveBlocker,
  abilityNameFor,
  buildAutoAbility,
  findDuplicate,
  inferScriptInputs,
  type AutoSaveDeps,
  type AutoSaveOutcome,
  type AutoSaveRun,
  type InferredScript,
  type VaryingValue,
} from "./ability-autosave.js";
export {
  IdleScheduler,
  DEFAULT_IDLE_CONFIG,
  classifyFailure,
  failedCheckNote,
  repairAbilityWhileIdle,
  withCheckNote,
  type AbilityCheckNote,
  type FailureKind,
  type IdleConfig,
  type IdleCheckVerdict,
  type IdleDeps,
  type IdleRepairDeps,
  type IdleRepairResult,
} from "./ability-idle.js";
export { matchControl, type FallbackTarget, type PageControl } from "./step-fallbacks.js";
export { testAllAbilities, type AbilityTestRow } from "./ability-test-all.js";
export { readOnlyHost } from "./ability-attempt.js";
export type {
  ObservedStep,
  Route,
  RouteInput,
  RouteStep,
  TargetWithFallbacks,
} from "./route-types.js";
export * from "./runtime/index.js";
export {
  navigateBackRewind,
  rewindForAbility,
  rewindForOperation,
  undoLabel,
  type Rewind,
} from "./rewind.js";
export { elapsedLabel, mcpCommandForSite, runReceipt, type RunReceipt } from "./run-receipt.js";
export {
  agentWriteSiteSkill,
  readSiteSkill,
  siteSkillBrief,
  SKILL_FILE,
  skillPath,
  writeSiteSkillUser,
} from "./site-skill.js";
export { OPS_FILE, opsPath, type SiteOpGuards, type SiteOpKind } from "./site-ops-file.js";
export {
  abilityOp,
  compileSiteOps,
  readSiteOps,
  runSiteOp,
  type SiteOp,
  type SiteOpRun,
  type SiteOpsFile,
} from "./site-ops.js";
export {
  allHelpers,
  dropHelper,
  helperProblem,
  saveHelper,
  type HelperAuthor,
  type SiteHelper,
} from "./site-helpers.js";
export {
  enableSiteHelpers,
  importSiteHelpers,
  isSiteHelperRequest,
  readSiteHelpers,
  siteHelperCall,
  type SiteHelperRequest,
} from "./site-helpers-call.js";
export { migrateLegacyHelpers } from "./site-memory-migrate.js";
export { exactTrigger } from "./route-match.js";
export { healingCall, opPageUrl, pageBundle, bundleExpression } from "./heal-call.js";
export {
  describeOperation as describeCatalogOperation,
  filledDefaults,
  howToCallFor,
  paramDescription,
  paramRequired,
  producerOf,
  visibleParams,
} from "./op-catalog.js";
export { mergeRotated } from "./rotated-merge.js";
export { NoPagination } from "./runtime/paginate.js";
