# Technical governance and schema evolution

> Adopted from the founder's governance corpus (drafted March 2026 for a lifelong companion) and generalised for any assistant built on this memory. "The operator" is whoever runs the service the memory lives in; for a single person on their own machine, that is the person. A policy is a claim about behaviour; [ENFORCEMENT.md](ENFORCEMENT.md) says which lines the code enforces, which a prompt carries, and which are still a person's decision. Policies change in the open: open an issue or a pull request.

## 1. Purpose and Scope

This policy governs the technical architecture, schema lifecycle, infrastructure decision-making, open standards compliance, and migration tooling requirements for the memory graph and supporting platform infrastructure. It translates the operator's core technical principles into specific, actionable rules that bind all engineering decisions from initial design through decades of operation.

This policy applies to:
- The memory graph schema and all versioned changes to it
- AI-proposed schema expansions and the review gates governing their approval
- Infrastructure decisions that affect the memory layer, storage backends, LLM adapters, and data portability
- All migration tooling and runbooks used to evolve schema or data in production
- All the operator engineers, contractors, third-party integrators, and AI agents operating within the operator technical platform

This policy operates within the operator four-domain governance framework:

| Governance Domain | Relevance to This Policy |
|---|---|
| **Technical** | Primary domain — schema versioning, infrastructure decisions, migration tooling, open standards |
| **Data** | Cross-reference to GOV-DAT-001 for memory entity model, retention schedules, and export requirements |
| **Ethical** | AI-proposed schema changes must not introduce surveillance vectors or erode user sovereignty |
| **AI Behavior** | AI agents may propose schema changes; they may never execute schema changes autonomously |

**Foundational principle:** the operator must survive technology shifts over decades. Every technical decision prioritizes open standards, reversibility, and user data portability over short-term convenience or vendor capability.

---

## 2. Core Technical Principles

These principles are non-negotiable constraints. No architecture decision, schema change, or infrastructure choice may contradict them.

| Principle | Binding Rule |
|---|---|
| Open standards over proprietary constructs | No memory data may be stored in a format that requires a proprietary tool to read, write, or export |
| LLM-agnostic memory layer | The memory graph schema and storage layer must not encode assumptions about any specific LLM's structure, tokenization, or embedding format |
| Data portability is non-negotiable | A full export of any user's memory graph in RDF/Turtle or JSON-LD must be available within 24 hours of request at all times |
| Local-first architecture | The on-device graph store is the source of truth; cloud sync is opportunistic and additive |
| AI assists, humans decide | AI agents may observe, propose, and model schema changes; they may never approve, deploy, or rollback schema changes without explicit human authorization |
| Reversibility by design | Every schema change must ship with a tested rollback procedure before it may be deployed to any user-facing environment |
| Auditability | All schema changes, infrastructure decisions, and migration operations must produce a permanent, immutable audit trail |

---

## 3. Schema Versioning and Change Management

### 3.1 Semantic Versioning for the Memory Graph Schema

The memory graph schema uses Semantic Versioning (`MAJOR.MINOR.PATCH`) as defined by semver.org. The schema version is a first-class artifact: it is stored in the schema registry, embedded in all export files, and checked by all migration tooling.

**Schema version location:** `schema/memory-graph/schema.json` — field `schemaVersion`

#### 3.1.1 Version Component Definitions

| Component | Increment When | Examples |
|---|---|---|
| **MAJOR** | A breaking change that makes previously valid data invalid, removes a node type, removes a relationship type, renames a required field, or changes a field's type in a non-backward-compatible way | `1.x.x → 2.0.0`: removing the `Belief` node type; changing `confidenceWeight` from Float to Integer |
| **MINOR** | A backward-compatible additive change: new optional node type, new optional relationship type, new optional metadata field, new relationship attribute that has a defined default | `1.0.x → 1.1.0`: adding a new `Goal` node type; adding an optional `emotionalValence` metadata field |
| **PATCH** | A backward-compatible non-structural change: documentation update, constraint clarification, default value correction, ontology label change with no structural impact | `1.0.0 → 1.0.1`: correcting a cardinality comment; updating a field description |

#### 3.1.2 Pre-Release and Build Metadata

| Label | Usage |
|---|---|
| `-alpha.N` | Under active development; not for production deployment |
| `-beta.N` | Approved for staged rollout under Tier 2 review; limited to approved cohorts |
| `-rc.N` | Release candidate; all validation gates passed, awaiting final the maintainers sign-off |
| `+build.YYYYMMDD` | Optional build metadata; not part of version precedence |

#### 3.1.3 Version Zero (Pre-Stability) Rules

While the schema is at `0.x.x`, MINOR increments may include breaking changes. The schema exits version zero when the maintainers and the maintainers jointly declare production stability. That declaration is recorded in an ADR (see Section 5).

### 3.2 Schema Registry and Catalog

The schema registry is the authoritative record of all schema versions. It is a Git-managed artifact stored in the the platform monorepo.

**Registry location:** `schema/memory-graph/registry/`

**Required registry contents:**

| Artifact | File Pattern | Description |
|---|---|---|
| Schema definition | `v{MAJOR}.{MINOR}.{PATCH}/schema.json` | Full JSON Schema document for this version |
| JSON-LD context | `v{MAJOR}.{MINOR}.{PATCH}/context.jsonld` | JSON-LD context mapping schema terms to IRI namespaces |
| RDF ontology | `v{MAJOR}.{MINOR}.{PATCH}/ontology.ttl` | Turtle serialization of the memory graph ontology |
| Changelog entry | `v{MAJOR}.{MINOR}.{PATCH}/CHANGELOG.md` | Human-readable description of all changes from previous version |
| Migration script | `v{MAJOR}.{MINOR}.{PATCH}/migrate-up.sql` or `.cypher` | Forward migration from the immediately preceding version |
| Rollback script | `v{MAJOR}.{MINOR}.{PATCH}/migrate-down.sql` or `.cypher` | Rollback to the immediately preceding version |
| Validation report | `v{MAJOR}.{MINOR}.{PATCH}/validation-report.json` | Output of the compliance validation suite (see Section 6) |
| ADR reference | `v{MAJOR}.{MINOR}.{PATCH}/adr-ref.txt` | ADR ID(s) that authorized this version |

All schema version directories are immutable once merged to the main branch. Corrections require a new PATCH version.

#### 3.2.1 Schema Tagging

Every merged schema version must be tagged in Git:

```
schema/v{MAJOR}.{MINOR}.{PATCH}
```

Tags are GPG-signed by the approving the maintainers or delegated Technical Lead. Unsigned tags on schema version directories are a blocking deployment gate failure.

### 3.3 Change Management Workflow

All schema changes — regardless of approval tier — follow this lifecycle:

```
Proposal → Triage → Review → Approval → Staging → Validation → Production → Monitoring → Close
```

#### 3.3.1 Proposal

All schema change proposals must be submitted as a Schema Change Proposal (SCP) document. SCPs are tracked as issues in the platform repository using the `schema-change-proposal` label.

**Required SCP fields:**

| Field | Description |
|---|---|
| `proposal_id` | Auto-assigned: `SCP-YYYY-NNN` |
| `proposed_by` | Name and role (human or AI agent identifier) |
| `proposed_date` | ISO 8601 date |
| `change_type` | `AddNodeType` / `AddRelationshipType` / `AddMetadataField` / `ModifyField` / `RemoveField` / `RemoveType` / `RefactorOntology` |
| `proposed_version_bump` | The MAJOR.MINOR.PATCH component that should increment |
| `description` | Plain-language summary of the change |
| `motivation` | Why this change is needed; what user or system need it addresses |
| `evidence` | For AI-proposed changes: statistical basis, pattern frequency, confidence interval (see Section 4.1) |
| `affected_entities` | List of node types, relationship types, or fields affected |
| `backward_compatibility` | Explicit analysis of backward compatibility impact |
| `migration_approach` | High-level description of how existing data will be migrated |
| `rollback_approach` | High-level description of how this change can be reversed |
| `open_standards_impact` | Analysis of impact on RDF/JSON-LD compliance (see Section 6) |
| `draft_adr_required` | Boolean — whether this change requires an ADR (see Section 5.1) |

#### 3.3.2 Triage

Within 48 hours of SCP submission, the on-call Technical Lead performs triage:
- Assigns an approval tier (Tier 1, 2, or 3 — see Section 4)
- Confirms the proposed version bump is correct
- Assigns reviewers per tier requirements
- Sets the SLA deadline
- Flags any open standards compliance concerns for pre-review

If the proposed tier is contested, the maintainers resolves the dispute within 24 hours of escalation.

#### 3.3.3 Backward Compatibility Maintenance

The following rules are absolute:

1. **MAJOR version changes** require a documented migration path for all data at every supported schema version. Support for reading data at `N-1` MAJOR versions must be maintained for a minimum of 24 months after a MAJOR version release.
2. **MINOR version changes** must be fully forward-compatible: a client running schema `1.0.x` must be able to read data written by schema `1.1.x` without data loss (unknown fields are preserved, not dropped).
3. **No field may be removed** without first going through a two-cycle deprecation: mark deprecated in version `N`, remove in version `N+2` at the earliest, with at least 90 days between cycles.
4. **Field type changes** that narrow the value space (e.g., String → Enum) are treated as breaking changes (MAJOR) unless a lossless coercion function is defined and deployed before the schema change is applied to existing data.
5. All export tooling must support the current and two prior MINOR versions simultaneously.

---

## 4. AI-Proposed Expansion Review Gates

### 4.1 How AI Proposes Schema Changes

AI agents within the operator may observe patterns in the memory graph that suggest a schema expansion would improve representational fidelity, reduce data loss, or better serve user needs. AI agents may surface these observations as SCP proposals. They may not submit SCPs without a human reviewing and counter-signing the proposal before it enters the review queue.

**Required evidence for AI-proposed SCPs:**

| Evidence Type | Required For | Minimum Threshold |
|---|---|---|
| Pattern frequency | All AI proposals | Observed pattern in ≥ 1,000 distinct user memory graphs OR ≥ 10,000 memory events |
| Confidence interval | All AI proposals | 95% confidence interval on pattern frequency estimate |
| Information loss analysis | Proposals adding new types/fields | Quantified estimate of information currently lost or distorted by absence of proposed construct |
| User impact projection | Tier 2 and Tier 3 proposals | Estimated % of active user base affected |
| Privacy impact statement | All proposals | Explicit statement that the proposal does not introduce new data collection beyond what the user has consented to |
| Schema stability impact | All proposals | Assessment of whether the change increases or decreases long-term schema complexity |

AI agents must identify themselves by agent identifier in the `proposed_by` field. All AI-originated SCPs are automatically flagged for human counter-signature before triage.

### 4.2 Approval Tiers

#### Tier 1 — Auto-Approved (Low Risk, Additive, Backward-Compatible)

**Criteria — ALL of the following must be true:**

| Criterion | Requirement |
|---|---|
| Change type | `AddMetadataField` (optional), `AddNodeType` (optional, no edges to existing required types), or documentation-only |
| Backward compatibility | Fully additive; no existing data is invalid after the change; no existing queries break |
| Version bump | MINOR or PATCH only |
| Migration | No data migration required OR a purely additive migration (append-only) with no transformation of existing records |
| Open standards | No new IRI namespaces introduced; change maps cleanly onto existing JSON-LD context or requires only an additive context extension |
| AI involvement | If AI-proposed: human counter-signature on SCP has been obtained |
| Prior expansion pattern | Change follows a pattern that has been pre-approved in the Expansion Pattern Catalog (maintained by the maintainers) |

**Process:**

1. SCP submitted and triaged as Tier 1
2. Automated validation suite runs within 2 hours (see Section 6.3)
3. If validation passes: change is auto-approved after **48-hour waiting period**
4. the maintainers has a **7-day override window** to escalate to Tier 2 or Tier 3 at any time during or after the 48-hour window before deployment to production
5. If no override: Technical Lead merges, tags, and schedules deployment

**Rollback:** Tier 1 changes must include a `migrate-down` script. Rollback is executed by the Technical Lead without change control board involvement. Rollback must complete within 4 hours of trigger decision.

**SLA:** 48-hour auto-approval window + 7-day the maintainers override window. Total maximum elapsed time before production: 10 days (if the maintainers override is exercised and resolved quickly).

#### Tier 2 — Staged Rollout (Structural, Requires Review)

**Criteria — ANY of the following triggers Tier 2:**

| Trigger |
|---|
| New required node type (has edges to existing required types) |
| New required field on an existing node type |
| New relationship type with cardinality constraints |
| Change to an existing field's constraints (e.g., narrowing allowed values) |
| New metadata dimension that affects confidence or decay computation |
| Any change affecting the JSON-LD context in a way that alters existing term resolution |
| MINOR version bump where migration touches existing records |
| Any change proposed by an AI agent that does not fit a pre-approved Expansion Pattern |

**Process:**

1. SCP submitted and triaged as Tier 2
2. the maintainers review initiated; **5-day review SLA** from triage date
3. the maintainers may approve, reject, escalate to Tier 3, or request revisions
4. If approved: schema version tagged as `-beta.N`
5. **21-day limited staged rollout** to a defined cohort (maximum 5% of active users, or a fixed internal test cohort)
6. Metrics gates must be defined before rollout begins (see Section 4.2.1)
7. At day 21: the maintainers reviews metrics gate results and makes one of: Promote to production / Extend staged rollout (max one 21-day extension) / Reject and rollback
8. Promotion to production requires the maintainers sign-off recorded in the SCP issue

**Rollback:** Tier 2 changes must include a tested `migrate-down` script executed against a production-mirror environment before staged rollout begins. Rollback during staged rollout must complete within 8 hours of trigger decision. The rollback plan must be reviewed and approved by the maintainers before the staged rollout begins.

**SLA:** 5-day the maintainers review + 21-day staged rollout + promotion decision within 3 business days of day 21.

#### 4.2.1 Tier 2 Metrics Gates

Before a Tier 2 staged rollout begins, the following metrics must be defined with pass/fail thresholds:

| Metric | What It Measures | Failure Condition |
|---|---|---|
| Schema validation error rate | % of memory write operations failing schema validation | > 0.1% of writes in the staged cohort |
| Export integrity | % of export jobs producing valid RDF/JSON-LD output | < 100% |
| Query regression | P99 latency of the 10 most-used memory graph queries | > 20% degradation vs. baseline |
| Migration idempotency | Re-running the migration produces no additional changes | Any re-run produces changes |
| Rollback integrity | Rollback from staged schema restores data to pre-migration state | Any data loss or corruption |
| User-visible error rate | Application error rate attributable to schema change | > 0.05% increase vs. baseline |

#### Tier 3 — Manual Review (High Risk, Novel, or Governance-Sensitive)

**Criteria — ANY of the following triggers Tier 3:**

| Trigger |
|---|
| MAJOR version bump (breaking change) |
| Removal of any node type, relationship type, or field |
| Change to the canonical ontology's foundational types (`Experience`, `Lesson`, `Conversation`, `Belief`, `Relationship`, `Skill`) |
| Change that affects the privacy classification, encryption key reference, or provenance attributes |
| Any change that alters how user data is exported or what data is included in exports |
| Introduction of a new IRI namespace or top-level ontology concept |
| Any change flagged by the Ethics Lead as having potential surveillance or autonomy-erosion implications |
| Any change where the maintainers and Technical Lead disagree on tier assignment |
| Any change that would require deprecation of a field currently in active use |
| Structural refactoring of the ontology (renaming types, merging types, splitting types) |

**Process:**

1. SCP submitted and triaged as Tier 3
2. the maintainers and the maintainers (Chief Ethics & Safety Officer) must both acknowledge the SCP within 48 hours
3. **Governance panel review** convened: the maintainers + the maintainers + Technical Lead + Data Governance Lead + (where applicable) external expert
4. Panel meets within **10 business days** of triage
5. Panel produces a written decision: Approve / Reject / Approve with Conditions
6. Approved changes must have: complete ADR (see Section 5), full migration plan with tested rollback, 30-day post-deployment monitoring plan with defined success criteria
7. **the maintainers + the maintainers co-sign** required on the final SCP before any deployment
8. Schema version tagged as `-rc.N` for internal validation before any production deployment
9. **30-day post-deployment monitoring** with weekly status reports to governance panel
10. Final sign-off at day 30 closes the SCP

**Rollback:** Tier 3 rollback plans must be approved by the governance panel before deployment. Rollback must be executable within 2 hours of trigger decision. A rollback drill must be conducted in a staging environment that mirrors production within 72 hours before the production deployment window.

**SLA:** 10 business days to panel review + panel decision within 5 business days + deployment scheduling within 10 business days of approval + 30-day monitoring period.

### 4.3 Approval Tier Decision Matrix

| Change Characteristic | Tier 1 | Tier 2 | Tier 3 |
|---|:---:|:---:|:---:|
| Optional metadata field, additive | ✓ | | |
| Optional node type, no required edge changes | ✓ | | |
| Documentation / label update | ✓ | | |
| New required node type | | ✓ | |
| New relationship type with cardinality | | ✓ | |
| Field constraint narrowing | | ✓ | |
| JSON-LD context term change | | ✓ | |
| MAJOR version (breaking change) | | | ✓ |
| Removal of type or field | | | ✓ |
| Change to foundational ontology types | | | ✓ |
| Affects privacy/encryption attributes | | | ✓ |
| Alters export content or format | | | ✓ |
| Ethics-flagged change | | | ✓ |

### 4.4 Override and Escalation Paths

| Scenario | Who Can Act | Action | Record Required |
|---|---|---|---|
| Tier 1 change warrants deeper review | the maintainers | Escalate to Tier 2 or Tier 3 within 7-day override window | SCP comment with rationale |
| Tier 2 change is more risky than assessed | the maintainers | Escalate to Tier 3 at any point before production deployment | SCP comment with rationale |
| Tier 2 change is less risky than assessed | the maintainers + the maintainers jointly | Downgrade to Tier 1 only if ALL Tier 1 criteria are met | ADR entry |
| the maintainers is unavailable for Tier 2 review | Delegated Technical Lead (designated in writing by the maintainers) | May approve Tier 2 with same authority | Delegation record in SCP |
| the maintainers/the maintainers disagree on Tier 3 approval | Neither can unilaterally override | Escalate to the operator Board governance committee | Formal written escalation |
| Emergency security patch requiring schema change | the maintainers unilateral | Emergency Tier 1 process; the maintainers notified within 2 hours; full post-incident review within 7 days | Emergency SCP + post-incident ADR |

---

## 5. Infrastructure Decision Log Format and Required Documentation

### 5.1 When an Architecture Decision Record (ADR) Is Required

An ADR is required for any decision that:

| Decision Category | Threshold for ADR Requirement |
|---|---|
| Storage backend selection or change | Any change to graph database technology, on-device storage engine, or cloud sync provider |
| LLM adapter design | Any decision establishing or changing the interface contract between the memory layer and LLM providers |
| Open standards adoption or deprecation | Any decision to adopt, drop, or version-pin a W3C/IETF standard |
| Schema MAJOR version | Every MAJOR version bump |
| Schema MINOR version with Tier 2 or Tier 3 approval | Any Tier 2 or Tier 3 approved schema change |
| Encryption or key management | Any change to encryption algorithms, key derivation, or key management architecture |
| Data portability format | Any change to export format, export tooling, or export API |
| Vendor or cloud provider selection | Any decision to adopt a new infrastructure vendor |
| Performance or scalability architecture | Decisions affecting horizontal scaling, sharding, replication topology |
| Security architecture | Decisions affecting the threat model, authentication, authorization, or audit logging |
| Governance tooling | Decisions affecting how SCPs, ADRs, or audit trails are stored or processed |

### 5.2 ADR Format and Template

All ADRs are stored in the library docs and follow this naming convention:

```
ADR-YYYY-NNN-{kebab-case-title}.md
```

**ADR Template:**

```markdown
# ADR-{YYYY}-{NNN}: {Title}

**Status:** {Proposed | Accepted | Deprecated | Superseded by ADR-YYYY-NNN}
**Date:** {YYYY-MM-DD}
**Deciders:** {Names and roles of decision-makers}
**Consulted:** {Names and roles of those consulted}
**Informed:** {Names and roles of those informed}
**Related SCPs:** {SCP-YYYY-NNN, ...}
**Supersedes:** {ADR-YYYY-NNN or "None"}

---

## Context

{Describe the architectural situation and the forces at play. What problem are we solving? What constraints exist? Why is a decision needed now? Reference relevant technical principles from GOV-TECH-001 Section 2.}

## Decision Drivers

- {Driver 1}
- {Driver 2}
- ...

## Options Considered

### Option A: {Name}

**Description:** {What this option entails}
**Pros:**
- ...
**Cons:**
- ...
**Open Standards Impact:** {Analysis}
**Vendor Lock-In Risk:** {Assessment: None / Low / Medium / High}
**Reversibility:** {Assessment: Easy / Moderate / Difficult / Irreversible}

### Option B: {Name}

{Same structure as Option A}

{Repeat for all considered options}

## Decision

**Chosen option:** {Option name}

**Rationale:** {Why this option was chosen over the alternatives. Reference the decision drivers explicitly.}

## Consequences

### Positive
- ...

### Negative / Trade-offs
- ...

### Risks and Mitigations
- {Risk}: {Mitigation}

## Alternatives Rejected

| Option | Primary Reason for Rejection |
|---|---|
| {Option B} | {Reason} |
| {Option C} | {Reason} |

## Compliance Verification

- [ ] Does not introduce vendor lock-in inconsistent with GOV-TECH-001 Section 2
- [ ] Open standards compliance verified per GOV-TECH-001 Section 6
- [ ] Data portability requirements from GOV-DAT-001 Section 4 are preserved
- [ ] Migration path from prior state is defined
- [ ] Rollback path is defined

## Review and Sign-Off

| Role | Name | Date | Signature |
|---|---|---|---|
| the maintainers | | | |
| the maintainers (if Tier 3 or ethics-relevant) | | | |
| Technical Lead | | | |
```

### 5.3 ADR Storage, Referencing, and Discoverability

- All ADRs are version-controlled in the platform monorepo
- ADRs are immutable once their status is `Accepted`: corrections require a new ADR that supersedes the prior one
- The the library docs file maintains a running index of all ADRs, their status, and cross-references to related SCPs and schema versions
- All SCPs must reference the ADR(s) that authorized the change in the `adr-ref.txt` file in the schema registry (see Section 3.2)
- ADRs are searchable via the platform's internal documentation system

### 5.4 ADR Review and Supersession

| Trigger | Required Action |
|---|---|
| A decision made in an ADR is no longer in effect | Create a new ADR marked as superseding the prior one; update prior ADR status to `Superseded` |
| A decision made in an ADR is partially reversed | Create a new ADR covering the delta; reference the original ADR as context |
| An ADR's technology is end-of-life'd by its vendor | Automatic trigger for a new ADR within 90 days of EOL announcement |
| Annual governance review | All `Accepted` ADRs from the prior 12 months are reviewed for continued validity; the maintainers sign-off required |

### 5.5 Technology Evaluation Criteria

Any evaluation of a new technology for the memory graph layer (graph database, LLM adapter, storage engine, sync protocol) must assess the following criteria before an ADR may be marked `Accepted`:

| Criterion | Evaluation Requirement |
|---|---|
| Open standards support | Does the technology support RDF, JSON-LD, or other open graph standards natively or via documented adapter? |
| Vendor lock-in risk | What is the estimated cost and complexity of migrating away from this technology? Is a migration path documented? |
| Data portability | Can all user data be exported in a vendor-neutral format without data loss? |
| Longevity and community | What is the technology's governance model? Is it open source? What is its trajectory over a 10-year horizon? |
| Security and encryption | Does the technology support at-rest and in-transit encryption? Does it support user-controlled encryption keys? |
| Local-first capability | Can the technology operate on-device without requiring a persistent network connection? |
| Query language standardization | Does the technology use an open or standardized query language (SPARQL, Cypher, GQL)? |
| Schema evolution support | Does the technology provide native tooling for schema migrations, versioning, or change management? |
| Performance under growth | What are the technology's known scaling limits at 10x and 100x current projected data volumes? |
| Regulatory compliance | Does the technology support GDPR, COPPA, and applicable data residency requirements? |

#### 5.5.1 Graph Database Evaluation (Current Candidates)

| Criterion | Amazon Neptune | Neo4j |
|---|---|---|
| Open standards (RDF/SPARQL) | Native RDF/SPARQL support | Via plugins; primary model is property graph |
| Vendor lock-in risk | High (managed AWS service) | Low-Medium (open core, self-hostable) |
| Local-first capability | No (cloud-only) | Yes (embedded / self-hosted) |
| JSON-LD support | Via RDF layer | Via APOC plugins |
| Schema migration tooling | Limited native tooling | Neo4j Migrations / Liquigraph |
| Portability | RDF export available | CSV/JSON export; Cypher scripts |
| Open query language | SPARQL (W3C standard) | Cypher (openCypher; ISO GQL converging) |

**Decision rule:** Any graph database selected as the primary on-device store must support local-first operation without a persistent network connection. Cloud-only options may only serve as the cloud sync layer, never the source of truth. This constraint eliminates Amazon Neptune as a primary on-device store candidate and limits its role to cloud sync only.

---

## 6. Open Standards Compliance

### 6.1 Mandatory Standards

The memory graph must comply with the following standards at all times:

| Standard | Version Required | Applies To | Governing Body |
|---|---|---|---|
| JSON-LD | 1.1 (W3C Recommendation, July 2020) | All memory graph export serializations; API responses returning graph data | W3C |
| RDF 1.1 | (W3C Recommendation, February 2014) | Turtle serialization of memory ontology; SPARQL query interface | W3C |
| Turtle (RDF Syntax) | RDF 1.1 Turtle (W3C Recommendation, February 2014) | Ontology files; full-export format | W3C |
| SPARQL 1.1 | (W3C Recommendation, March 2013) | Query interface over the RDF layer | W3C |
| JSON Schema | Draft 2020-12 (or latest stable) | Schema definition files in the registry | IETF/JSON Schema Org |
| UUID | RFC 4122 (v4) | All node and edge identifiers | IETF |
| ISO 8601 | (ISO Standard) | All timestamps in exported data | ISO |
| SHACL | (W3C Recommendation, July 2017) | Shape constraints for memory graph validation | W3C |

**Standards version pinning:** The specific versions above are pinned as of the effective date of this policy. Adoption of a new major version of any listed standard requires a Tier 2 or Tier 3 schema change review, depending on impact, and a corresponding ADR.

### 6.2 JSON-LD Context Document Requirements

Every schema version in the registry must include a JSON-LD context document (`context.jsonld`) that satisfies the following requirements:

1. **IRI namespace declaration:** All the operator-defined terms must be declared under the canonical the operator namespace: `https://schema.albuddy.ai/memory/v{MAJOR}/`
2. **Term mapping completeness:** Every node type, relationship type, and metadata field defined in `schema.json` must have a corresponding term mapping in `context.jsonld`
3. **External vocabulary alignment:** Where the operator terms correspond to established vocabularies (schema.org, FOAF, Dublin Core), the JSON-LD context must declare the `@type` or `owl:sameAs` alignment
4. **Version-stamped context URL:** The `@context` URI embedded in all exports must include the schema version: `https://schema.albuddy.ai/memory/v{MAJOR}.{MINOR}.{PATCH}/context.jsonld`
5. **No blank nodes as identifiers:** All memory nodes must use IRIs derived from their UUID: `https://data.albuddy.ai/memory/{userId}/{nodeId}`
6. **Language tagging:** All human-readable string values in exported data must carry `@language` tags per BCP 47
7. **Compacted form availability:** The context must support both compacted and expanded JSON-LD forms without information loss

**Validation tool:** `albuddy-schema-validator validate-jsonld --context {path} --schema {path}` must pass with zero errors before any context document is admitted to the registry.

### 6.3 RDF/Turtle Serialization Requirements

The ontology file (`ontology.ttl`) for each schema version must:

1. Define all node types as `owl:Class` subclasses of `albuddy:MemoryNode`
2. Define all relationship types as `owl:ObjectProperty` or `owl:DatatypeProperty` with declared domain and range
3. Declare all metadata fields as `owl:DatatypeProperty` with XSD datatype declarations
4. Include `rdfs:label` and `rdfs:comment` annotations for all classes and properties
5. Declare all deprecated terms using `owl:deprecated true` with a `rdfs:seeAlso` reference to the replacement
6. Pass `rapper --input turtle --output turtle` round-trip serialization without data loss
7. Pass OWL DL consistency check (no OWL Full constructs permitted)
8. Include provenance metadata: `dct:created`, `dct:modified`, `dct:creator`, `owl:versionInfo`

### 6.4 Compliance Validation Steps

The following validation steps must pass before any schema change proceeds past the Triage stage:

| Step | Tool / Method | Pass Criterion |
|---|---|---|
| JSON Schema validity | `ajv validate` against JSON Schema Draft 2020-12 meta-schema | Zero errors |
| JSON-LD context validity | `jsonld` CLI processor — expand and compact round-trip | No information loss |
| Turtle syntax | `rapper --input turtle` | Zero parse errors |
| OWL consistency | Hermit or Pellet reasoner | Ontology is OWL DL consistent; no unsatisfiable classes |
| SHACL shape validation | `pySHACL` against the graph's SHACL shapes document | Zero constraint violations on sample dataset |
| Backward compatibility | `albuddy-schema-compat-check --old {prev-version} --new {proposed-version}` | No unintended breaking changes flagged |
| Migration dry-run | `albuddy-migrate --dry-run --from {prev-version} --to {proposed-version}` | Zero errors; no data loss reported |
| Export round-trip | Export sample data as JSON-LD → reimport → compare | Zero semantic difference |

**All validation steps must be run as part of the CI/CD pipeline on every pull request touching the `schema/memory-graph/` directory.** A failing validation gate blocks merge.

### 6.5 Compliance Reviews

A full compliance review is triggered by any of the following events:

| Trigger | Review Scope | SLA |
|---|---|---|
| Tier 2 or Tier 3 schema change approved | Full compliance validation suite on proposed version | Before staged rollout begins |
| W3C or IETF publishes a new major version of a listed standard | Gap analysis against new standard; ADR required | Within 60 days of standard publication |
| Annual governance review | Spot-check of 5 randomly selected schema versions in the registry | Within the Q1 governance review cycle |
| External security or compliance audit | Scope defined by audit scope | Per audit timeline |
| User data export complaint | Review of export compliance for the affected schema version | Within 5 business days of complaint |
| New export target platform identified | Compliance review for the new target format | Before export feature is released |

### 6.6 Standards Compliance Sign-Off

Every schema version in the registry must include a compliance attestation signed by the Technical Lead:

```
Schema Version: {version}
Compliance Validation Date: {YYYY-MM-DD}
Validator: {Name, Role}
Validation Report: {path to validation-report.json}
Standards Verified: JSON-LD 1.1, RDF 1.1, Turtle (RDF 1.1), SPARQL 1.1, JSON Schema Draft 2020-12, SHACL
Result: PASS
Notes: {any notes on known limitations or accepted deviations}
```

---

## 7. Migration Tooling Requirements

### 7.1 Required Migration Tooling Capabilities

All migration tooling used for the operator schema migrations must provide the following capabilities:

| Capability | Requirement |
|---|---|
| **Dry-run mode** | Every migration must be executable in dry-run mode, producing a detailed report of all changes that would be made without modifying any data. Dry-run must be the default mode; production execution requires an explicit `--execute` flag. |
| **Idempotency** | Every migration must be idempotent: running it multiple times on the same dataset must produce the same result as running it once. The tool must detect and report if a migration has already been applied and exit cleanly without error. |
| **Audit trail** | Every migration execution (including dry-runs) must produce a timestamped, append-only audit log recording: migration ID, schema version transition, start time, end time, executing user/service account, number of records inspected, number of records modified, number of errors, and a cryptographic hash of the migration script. |
| **Rollback** | Every migration must ship a paired `migrate-down` script. The rollback script must be tested independently before the forward migration may be deployed to production. |
| **Partial failure handling** | Migrations must be transactional where the underlying store supports transactions. Where transactions are not available, migrations must record progress at defined checkpoints and support resuming from the last checkpoint. |
| **Progress reporting** | Long-running migrations must emit progress updates at minimum every 60 seconds, including estimated time remaining and records processed/remaining. |
| **Pre-flight checks** | Before executing any migration, the tool must verify: correct source schema version is installed, required indexes exist, target schema version artifacts are present in the registry, sufficient storage space is available. |
| **Post-migration verification** | After migration completes, the tool must run the compliance validation suite (Section 6.4) against the migrated data automatically. Verification failures must be surfaced as blocking errors, not warnings. |
| **Version locking** | The migration tool version must be pinned per migration script. Running a migration with a mismatched tool version is a blocking error. |

### 7.2 Migration Versioning and Tracking

Each migration script is identified by:

```
migration-{source-schema-version}-to-{target-schema-version}
```

Example: `migration-1.2.0-to-1.3.0`

Migrations are tracked in the schema registry alongside the schema version they produce (see Section 3.2). A migrations manifest file (`schema/memory-graph/registry/migrations-manifest.json`) records all applied migrations for each deployment environment:

```json
{
  "environment": "production",
  "migrations": [
    {
      "id": "migration-1.0.0-to-1.1.0",
      "applied_at": "2026-04-15T14:32:00Z",
      "applied_by": "deploy-service-account",
      "duration_seconds": 142,
      "records_modified": 4821093,
      "audit_log_ref": "s3://albuddy-audit-logs/migrations/migration-1.0.0-to-1.1.0-20260415.log",
      "checksum": "sha256:{hash}"
    }
  ]
}
```

The manifest is append-only and is a regulated audit artifact under GOV-DAT-001.

### 7.3 Migration Testing Requirements

| Test Type | Requirement | When Run |
|---|---|---|
| **Unit tests** | Every migration function or transformation must have unit tests with at least the following cases: empty input, single record, record at boundary conditions, record with null/optional fields, record with maximum field values | In CI on every PR touching migration scripts |
| **Backward compatibility tests** | After migration, all queries written for the previous schema version must return semantically equivalent results or fail with a documented, expected error | In CI on every PR touching migration scripts |
| **Integration tests** | Migration run against a dataset representative of production data distribution (minimum 10,000 records, covering all node types and relationship types) | In CI as a nightly job and before any production deployment |
| **Rollback tests** | Rollback script applied after forward migration produces a dataset byte-identical (or semantically equivalent for non-deterministic operations) to the pre-migration state | In CI on every PR; must pass before production deployment |
| **Idempotency tests** | Migration applied twice produces same result as applying once; migration tool correctly detects and reports prior application | In CI on every PR |
| **Performance tests** | Dry-run against a dataset of estimated production size; migration time must be within the declared maintenance window | Before Tier 2 or Tier 3 production deployment |
| **Export round-trip tests** | After migration, export a sample of migrated records as JSON-LD and RDF/Turtle; reimport; compare with pre-migration export | Before any production deployment |
| **Smoke tests** | Post-deployment verification: 10 predefined queries return expected results against production data after migration | Immediately after production migration completes |

### 7.4 Migration Runbook Template

Every production migration requires a completed runbook before it may be scheduled. Runbooks are stored in `docs/runbooks/migrations/` and named `runbook-migration-{source}-to-{target}-{YYYY-MM-DD}.md`.

```markdown
# Migration Runbook: {source-schema-version} → {target-schema-version}

**Runbook ID:** RUNBOOK-MIG-{YYYY}-{NNN}
**Migration Script:** migration-{source}-to-{target}
**Target Deployment Date:** {YYYY-MM-DD}
**Maintenance Window:** {start time} – {end time} {timezone}
**Run By:** {Name, Role}
**Approved By:** {the maintainers Name} (Tier 2/3) | {Technical Lead Name} (Tier 1)
**Related SCP:** {SCP-YYYY-NNN}
**Related ADR:** {ADR-YYYY-NNN or "None"}

---

## Pre-Deployment Checklist

- [ ] Migration script version matches pinned tool version
- [ ] Dry-run completed against production-mirror environment; output reviewed and signed off
- [ ] Rollback script tested against production-mirror environment
- [ ] All CI test suites passing (unit, integration, rollback, idempotency, performance)
- [ ] Compliance validation suite passing against migrated production-mirror data
- [ ] Backup/snapshot of production database taken and verified within 2 hours of migration start
- [ ] On-call engineer confirmed available for migration window duration + 4 hours
- [ ] Rollback decision authority confirmed (who can trigger rollback, by what criteria)
- [ ] User communication sent (if migration requires maintenance window affecting users)
- [ ] Monitoring dashboards configured for migration metrics gates (Tier 2: see Section 4.2.1)

## Migration Steps

1. {Step 1 — exact command}
2. {Step 2 — exact command}
...

## Verification Steps (Post-Migration)

1. Run smoke tests: `albuddy-migrate --smoke-test --schema-version {target-version}`
2. Verify export round-trip for sample user: `albuddy-export --user-id {test-user-id} --format jsonld | albuddy-import --validate-only`
3. Verify migrations manifest updated: `cat schema/memory-graph/registry/migrations-manifest.json | jq '.migrations[-1]'`
4. Confirm audit log written: {check command}
5. {Additional verification steps}

## Rollback Procedure

**Trigger criteria:** Rollback must be initiated if any of the following occur:
- Smoke tests fail
- Schema validation error rate exceeds {threshold from Tier metrics gates}
- Export integrity failures detected
- Any P1 or P0 error attributable to the migration within the first 4 hours post-deployment

**Rollback steps:**
1. {Rollback step 1 — exact command}
2. {Rollback step 2 — exact command}
...

**Rollback verification:**
1. {Verification step}
2. {Verification step}

## Escalation Contacts

| Role | Name | Contact |
|---|---|---|
| Migration owner | | |
| the maintainers (Tier 2/3) | | |
| On-call engineer | | |
| Database administrator | | |

## Post-Migration Actions

- [ ] Update migrations manifest in version control
- [ ] Close SCP issue with migration completion timestamp
- [ ] Post migration summary to engineering channel
- [ ] Schedule 30-day post-deploy monitoring review (Tier 3 only)
```

### 7.5 Deployment Process for Migrations

| Migration Tier | Deployment Method | Maintenance Window | Approval Required Before Deploy |
|---|---|---|---|
| **Tier 1** | Rolling deployment; no maintenance window required if migration is purely additive and completes in < 5 minutes on estimated production dataset | None required | Technical Lead sign-off on runbook |
| **Tier 2** | Blue/green deployment; traffic shifted only after smoke tests pass on green environment | Required if migration duration > 15 minutes on estimated production dataset | the maintainers sign-off on runbook; metrics gates defined |
| **Tier 3** | Blue/green deployment with full maintenance window; zero production traffic during migration execution | Always required; minimum 2-hour window; user communication required 48 hours in advance | the maintainers + the maintainers co-sign on runbook; rollback drill completed |

#### 7.5.1 Blue/Green Deployment Requirements for Schema Migrations

For Tier 2 and Tier 3 migrations using blue/green deployment:

1. The green environment receives the migrated schema and data before any production traffic
2. All smoke tests and compliance validation must pass on the green environment before traffic is shifted
3. Traffic shift must be gradual: 5% → 25% → 100% with a minimum 15-minute hold at each step
4. Rollback capability (reverting traffic to blue environment) must remain available for a minimum of 72 hours after full traffic shift to green
5. The blue environment must not be decommissioned until the 72-hour rollback window has passed and the maintainers has explicitly signed off

---

## 8. Governance Roles and Responsibilities

| Role | Schema Change Responsibilities |
|---|---|
| **Chief Technology Officer (the maintainers)** | Owns this policy; approves all Tier 2 changes; co-approves all Tier 3 changes; maintains the Expansion Pattern Catalog; exercises 7-day override window on Tier 1 changes; delegates authority in writing when unavailable |
| **the maintainers** | Co-approves all Tier 3 changes; flags ethics-sensitive proposals; reviews AI-proposed schema changes for surveillance or autonomy-erosion implications; co-signs Tier 3 runbooks |
| **Technical Lead** | Triages all SCPs within 48 hours; executes Tier 1 deployments; leads Tier 2 staged rollouts under the maintainers direction; produces draft ADRs; maintains ADR index |
| **Data Governance Lead** | Reviews schema changes for compliance with GOV-DAT-001; attends Tier 3 governance panel; owns export compliance verification |
| **AI Agents** | May propose SCPs with supporting evidence; may not approve, reject, or deploy schema changes; must identify themselves in SCP proposals; require human counter-signature before proposal enters review queue |
| **All Engineers** | Must adhere to schema versioning rules; must run validation suite before raising a PR on schema artifacts; must not deploy schema changes without an approved SCP and runbook |

---

## 9. Policy Enforcement and Violations

| Violation | Classification | Response |
|---|---|---|
| Schema change deployed without an approved SCP | Critical | Immediate rollback; incident report; the maintainers notification within 2 hours; post-incident review |
| Migration deployed without completed runbook | High | Rollback if feasible; incident report; process review |
| Schema version tagged without GPG signature | High | Tag invalidated; re-tag required; process review |
| AI agent executes schema change without human approval | Critical | Immediate rollback; agent suspended pending investigation; the maintainers and the maintainers notification within 1 hour |
| Validation suite bypassed in CI | High | PR reverted; engineering team notified; process review |
| ADR not created when required | Medium | ADR must be retroactively created and approved; corrective action plan |
| Schema change deployed without tested rollback script | Critical | Immediate rollback; incident report; the maintainers notification within 2 hours |

All incidents in the Critical or High classification are recorded in the operator incident log and reviewed in the quarterly governance review.

---

## 10. Policy Review and Maintenance

| Trigger | Required Action |
|---|---|
| Scheduled quarterly review (next: 2026-06-19) | the maintainers reviews policy for continued accuracy; minor updates require the maintainers approval; structural changes require governance panel |
| New W3C/IETF standard published affecting listed standards | Section 6.1 reviewed and updated; ADR required if pinned versions change |
| Major infrastructure change (new graph DB, new LLM adapter) | ADR required; relevant sections of this policy reviewed for updates |
| Tier 3 post-deployment monitoring reveals governance gap | Policy updated within 30 days of gap identification |
| the operator governance framework restructure | This policy revised in coordination with all domain policy owners |

Policy version history is maintained in Git. All changes to this document require a pull request reviewed by the maintainers and at minimum one other governance domain owner.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **ADR** | Architecture Decision Record — a document recording a significant technical decision, its context, options considered, rationale, and consequences |
| **Backward compatibility** | The property of a schema change that allows existing data and queries to continue functioning without modification after the change is applied |
| **Blue/green deployment** | A deployment strategy where two identical production environments (blue and green) are maintained; the new version is deployed to the inactive environment and traffic is switched after validation |
| **the maintainers** | Chief Ethics & Safety Officer — the governance role responsible for ethical review of AI behavior and data handling |
| **Compliance validation suite** | The automated test suite that verifies JSON-LD, RDF, SHACL, and schema consistency for every schema version |
| **Dry-run** | A migration execution mode that produces a complete report of all changes that would be made without modifying any data |
| **Expansion Pattern Catalog** | A the maintainers-maintained list of pre-approved schema expansion patterns eligible for Tier 1 auto-approval |
| **IRI** | Internationalized Resource Identifier — a generalization of URI used in RDF and JSON-LD to globally identify terms |
| **JSON-LD** | JavaScript Object Notation for Linked Data — a W3C standard for expressing Linked Data using JSON |
| **LLM-agnostic** | The architectural property of the memory layer that ensures it does not encode assumptions about any specific large language model |
| **MAJOR version** | A schema version component that increments when a breaking change is introduced |
| **Memory graph** | The semantic graph database that stores all the operator user memory data as typed nodes and edges |
| **MINOR version** | A schema version component that increments when a backward-compatible additive change is introduced |
| **Ontology** | A formal representation of knowledge as a set of concepts and relationships; the operator's memory ontology defines node types, relationship types, and their properties |
| **PATCH version** | A schema version component that increments when a backward-compatible non-structural change is introduced |
| **RDF** | Resource Description Framework — a W3C standard for representing information about resources in a graph |
| **Rollback** | The process of reverting a schema change and its associated data migrations to restore the prior schema version |
| **Schema registry** | The Git-managed directory containing all versioned schema artifacts, migration scripts, and validation reports |
| **SCP** | Schema Change Proposal — the formal document used to propose, track, and record approval of a schema change |
| **Semantic versioning** | A versioning scheme using MAJOR.MINOR.PATCH components with defined rules for when each component increments |
| **SHACL** | Shapes Constraint Language — a W3C standard for validating RDF graphs against a set of shape constraints |
| **Staged rollout** | A deployment strategy where a change is released to a limited cohort before full production deployment, allowing metrics-gated promotion |
| **Turtle** | A compact, human-readable serialization format for RDF data |

---

## Appendix B: Standards Reference

| Standard | Full Name | Version | URI | Governs |
|---|---|---|---|---|
| JSON-LD | JavaScript Object Notation for Linked Data | 1.1 | https://www.w3.org/TR/json-ld11/ | Graph export serialization |
| JSON-LD Processing | JSON-LD 1.1 Processing Algorithms and API | 1.1 | https://www.w3.org/TR/json-ld11-api/ | Context processing |
| JSON-LD Framing | JSON-LD 1.1 Framing | 1.1 | https://www.w3.org/TR/json-ld11-framing/ | Structured graph output |
| RDF Concepts | RDF 1.1 Concepts and Abstract Syntax | 1.1 | https://www.w3.org/TR/rdf11-concepts/ | Graph data model |
| Turtle | RDF 1.1 Turtle | — | https://www.w3.org/TR/turtle/ | Ontology serialization |
| SPARQL | SPARQL 1.1 Query Language | 1.1 | https://www.w3.org/TR/sparql11-query/ | Graph query interface |
| SHACL | Shapes Constraint Language | — | https://www.w3.org/TR/shacl/ | Schema validation |
| OWL | OWL 2 Web Ontology Language | 2 | https://www.w3.org/TR/owl2-overview/ | Ontology expressiveness |
| JSON Schema | JSON Schema Validation | Draft 2020-12 | https://json-schema.org/draft/2020-12 | Schema definition |
| UUID | A Universally Unique Identifier (UUID) URN Namespace | RFC 4122 | https://www.rfc-editor.org/rfc/rfc4122 | Node identifiers |
| ISO 8601 | Date and time — Representations for information interchange | — | https://www.iso.org/iso-8601-date-and-time-format.html | Timestamps |
| BCP 47 | Tags for Identifying Languages | — | https://www.rfc-editor.org/rfc/bcp/bcp47.txt | Language tagging in exports |
| Semantic Versioning | Semantic Versioning Specification | 2.0.0 | https://semver.org/spec/v2.0.0.html | Schema version numbering |

---

## Appendix C: Cross-References to GOV-DAT-001

| Topic | Section in This Policy | Section in GOV-DAT-001 |
|---|---|---|
| Memory node and edge anatomy | §3.1 (schema versioning applies to this model) | §2.1 Memory Node Anatomy, §2.2 Relationship Edge Anatomy |
| Export format requirements (RDF, JSON-LD) | §6.1 Mandatory Standards | §4 Data Portability and Export |
| Data retention and deprecation schedules | §3.3.3 Backward Compatibility rule #3 | §3 Retention Schedules |
| Encryption key reference attribute | §4.2 Tier 3 criteria | §5 Encryption and Key Management |
| Provenance attribute | §4.2 Tier 3 criteria | §2.1 Memory Node Anatomy |
| Privacy classification attribute | §4.2 Tier 3 criteria | §2.1 Memory Node Anatomy |
| Audit trail requirements for migrations | §7.1 Audit trail capability | §6 Audit Logging |
| User export on demand | §6.1 data portability requirement | §4.1 On-Demand Export |
| AI agent identity and accountability | §4.1 AI proposal requirements | §7 AI Stewardship Accountability |

---

## Appendix D: Related Policies

- `GOV-DAT-001` — [Data Governance & Memory Stewardship Policy](data-stewardship.md)
- `GOV-ETH-001` — [Ethical AI Behavior Governance Policy](ethical-behaviour.md)
- `GOV-PRI-001` — [User Sovereignty & Privacy Policy](user-sovereignty-and-privacy.md)
- `GOV-LIF-001` — [Lifecycle & Age-Appropriate Governance Policy](lifecycle-and-age-appropriate.md)

---

*This document is version-controlled. The authoritative source is the the platform monorepo at `docs/governance/technical-governance-schema-evolution-policy.md`. Questions or proposed amendments should be directed to the maintainers.*
