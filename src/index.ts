/**
 * al-buddy-memory — portable, governed, model-agnostic memory for AI agents.
 *
 * Facts are invalidated (validTo), never overwritten; on a governed handle
 * erasure runs through policy and is audited; raw text is the source of truth
 * and immutable; embeddings are a
 * disposable, model-tagged cache; every fact and link exports to one documented
 * portable format. See docs/SPEC.md.
 */
export * from "./types/memory.js";
export { InMemoryStore } from "./in-memory-store.js";
export { SqliteMemoryStore, DEFAULT_DB_PATH } from "./sqlite-memory-store.js";
export { ProjectMemory, projectDbPath, DEFAULT_MEMORY_DIR } from "./project-memory.js";
export type { CaptureInput, ProjectMemoryOptions } from "./project-memory.js";
export { renderMemoryBlock } from "./memory-block.js";
export { exportMemoryMarkdown } from "./memory-export.js";
export { FakeEmbedder, LocalEmbedder, cosineSimilarity } from "./embedder.js";
export type { Embedder } from "./embedder.js";
export { HybridRetriever, indexMissingEmbeddings } from "./hybrid-retriever.js";
export { matchesFilter } from "./query-filter.js";
export type { NodeFilter } from "./query-filter.js";
export type { RecallOptions } from "./hybrid-retriever.js";
export { exportPortable, importPortable, PORTABLE_FORMAT_VERSION } from "./memory-portability.js";
export type { PortableExport, PortableProject, ImportSummary } from "./memory-portability.js";
export { buildSourceProvenance, readSourceProvenance } from "./provenance.js";
export type { SourceExchange } from "./provenance.js";
export { effectiveConfidence, lastTouched, compareRecency, learnedAt, DECAY_FLOOR } from "./decay.js";
export { PinnedBlocks, PINNED_TAG, DEFAULT_PINNED_BUDGET } from "./pinned.js";
export type { PinInput, PinnedBlock } from "./pinned.js";
export { consolidate, listConsolidations, undoConsolidation } from "./consolidation.js";
export type { ConsolidateOptions, ConsolidationReport, ConsolidatedFact, ConsolidationRun, DerivedFact, RawExcerpt, Retraction, UndoConsolidationReport } from "./consolidation.js";
// The MCP server lives at "al-buddy-memory/mcp": it needs the optional `zod`
// and `@modelcontextprotocol/sdk`, and the core must import without them.
export { scoreConformance, formatReport, toConformanceInput, detectFormat, fromPortable, fromBlocks, fromRecords, proveRoundTrip } from "./conformance/index.js";
export type { ConformanceReport, ConformanceInput, ConformanceFact, Dimension, ExportFormat } from "./conformance/index.js";
export { govern, exportView, PolicyDenied, MemoryAudit, JsonlAudit, ChainedAudit, verifyAuditChain, personalDefaults, guardianMode, enterpriseAudit, looksSecret } from "./governance/index.js";
export type { GovernancePolicy, PolicyContext, Purpose, GovernOptions, AuditEvent, AuditSink, AuditChainResult, ErasureSubject, NodePatch } from "./governance/index.js";
export { IMMUTABLE_NODE_FIELDS, assertRestorable } from "./immutable.js";
export { canonicalInstant } from "./instant.js";
