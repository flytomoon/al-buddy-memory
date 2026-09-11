# Data stewardship: retention, deletion, portability

> Adopted from the founder's governance corpus (drafted March 2026 for a lifelong companion) and generalised for any assistant built on this memory. "The operator" is whoever runs the service the memory lives in; for a single person on their own machine, that is the person. A policy is a claim about behaviour; [ENFORCEMENT.md](ENFORCEMENT.md) says which lines the code enforces, which a prompt carries, and which are still a person's decision. Policies change in the open: open an issue or a pull request.

## 1. Purpose and Scope

This policy governs how the operator creates, stores, retains, archives, exports, evolves, replicates, and deletes user memory data across the entire lifecycle of the platform. It translates the operator masterplan's memory stewardship principles into specific, actionable rules that bind all system components, engineers, and operational teams.

This policy operates within the this governance framework across all four domains:

| Governance Domain | Relevance to This Policy |
|---|---|
| **Technical** | Architecture constraints for local-first storage, encryption, replication, and disaster recovery |
| **Ethical** | User sovereignty over memory, prohibition of surveillance and dark patterns, right to intentional forgetting |
| **Data** | Retention schedules, portability formats, export tooling, schema evolution governance |
| **AI Behavior** | AI's role as a memory steward agent — proposing consolidations, summarizations, and schema changes under human governance authority |

This policy applies to:
- All user memory data stored in the memory graph (on-device and cloud layers)
- All AI-generated summarizations, consolidations, and schema proposals
- All data export, portability, and deletion operations
- All replication, backup, and disaster recovery infrastructure
- All the operator's staff, contractors and third-party partners who operate, access, or maintain memory data infrastructure

**Foundational principle:** Memory belongs to the user. The operator is a steward, not an owner. Every architectural and operational decision in this policy flows from that principle.

---

## 2. Memory Entity Model

### 2.1 Memory Node Anatomy

Every memory node in the memory graph has the following defined attributes. This schema is the canonical reference for all storage, export, and governance operations.

| Attribute | Type | Mutability | Description |
|---|---|---|---|
| `nodeId` | UUID v4 | Immutable | Permanent identifier for the node across all storage layers |
| `memoryType` | Enum | Mutable | One of: `Experience`, `Lesson`, `Conversation`, `Belief`, `Relationship`, `Skill` |
| `content` | Structured object | Mutable | The substantive memory payload |
| `contextualMetadata` | Key-value map | Mutable | Annotations, tags, themes, user-added labels |
| `temporalAnchors` | Timestamp array | Append-only | When the memory was created, recalled, reinforced, or modified |
| `confidenceWeight` | Float [0.0–1.0] | Mutable | Current estimated relevance/freshness of the node |
| `decayRate` | Float | Mutable | Rate at which confidence degrades without reinforcement |
| `provenance` | Enum + reference | Immutable at creation | Source: `UserInput`, `AIInferred`, `GuardianAdded`, `SystemGenerated` |
| `privacyClassification` | Enum | Mutable by user | `Public`, `Private`, `Sensitive`, `Sealed` |
| `retentionTier` | Enum | Mutable | Current tier: `FullRetention`, `Summarized`, `Archived`, `PendingDeletion` |
| `encryptionKeyRef` | String | Immutable | Reference to the user-controlled key used to encrypt this node |

### 2.2 Relationship Edge Anatomy

Typed edges connect memory nodes into a semantic graph. All edges carry:

| Attribute | Description |
|---|---|
| `edgeId` | Immutable UUID |
| `sourceNodeId` | Origin node reference |
| `targetNodeId` | Destination node reference |
| `relationshipType` | One of: `Cause`, `Analogy`, `Reinforcement`, `Contradiction`, `Temporal`, `Emotional`, `Conceptual` |
| `strength` | Float [0.0–1.0] — confidence in the relationship |
| `provenance` | `UserAsserted` or `AIInferred` |
| `createdAt` | ISO 8601 timestamp |

### 2.3 Privacy Classification Definitions

| Classification | Meaning | Access Controls |
|---|---|---|
| `Public` | User has designated this memory as shareable | Accessible to user, AI, and any guardian or trusted advisor the user has designated |
| `Private` | Default for most memories | Accessible to user and AI; not accessible to guardians beyond Phase 1 defaults |
| `Sensitive` | User-flagged as personally significant | Accessible to user and AI only; excluded from summarization by default unless user explicitly opts in |
| `Sealed` | User has locked this node from AI processing | Stored encrypted; AI may not read, reference, or summarize sealed nodes |

---

## 3. Memory Retention, Archival, and Deletion Schedule

### 3.1 Governing Principle

Retention is driven by user intent, not by system timers. The default posture is indefinite retention of all memory nodes. Automatic transitions through retention tiers occur only for raw transient data (e.g., unprocessed conversation logs) or when the user has explicitly configured automated retention rules.

No memory is deleted without either explicit user action or a clearly defined and disclosed automatic rule the user has consented to. Intentional forgetting is a first-class capability, not an afterthought.

### 3.2 Retention Tiers

| Tier | Description | Who Can Trigger |
|---|---|---|
| **Full Retention** | Node is stored in its original form, fully indexed, fully searchable | Default state for all nodes |
| **Summarized** | Original content is condensed into an AI-generated narrative summary; raw content is deleted after summary confirmation | AI (on schedule, user-confirmed) or user-initiated |
| **Archived** | Node is moved to cold storage; excluded from active AI context window and search by default; retrievable on demand | User-initiated or automatic per schedule |
| **Pending Deletion** | Node is queued for permanent deletion; 14-day grace period before irreversible destruction | User-initiated only |
| **Deleted** | Node and all associated edges are cryptographically zeroed and removed from all storage layers | Automatic after Pending Deletion grace period |

### 3.3 Automatic Retention Schedule for Raw Conversation Logs

Raw conversation logs — the verbatim transcript buffers captured during user sessions — follow a mandatory automatic schedule regardless of other retention settings. This schedule applies to data classified as `memoryType: Conversation` in `provenance: UserInput`.

| Stage | Trigger | Action |
|---|---|---|
| **Summarization window** | 30 days after session close | AI generates a narrative summary of the conversation; summary is presented to user for review and confirmation before raw log is altered |
| **Raw log deletion** | 90 days after session close, OR upon user confirmation of the summary (whichever comes first) | Raw verbatim transcript deleted from all layers; summary node promoted to `FullRetention` |
| **Summary retention** | Indefinite | Conversation summary nodes are retained indefinitely unless the user explicitly deletes them |
| **User override — extend raw** | Any time before the 90-day mark | User may flag individual conversations to retain raw transcript indefinitely |
| **User override — delete immediately** | Any time | User may delete raw log or summary at any time with immediate effect |

**Notification requirement:** The system must notify the user at day 20 (10 days before the summarization window) that automatic summarization is approaching and offer an opt-out or extend option.

### 3.4 Automatic Retention Schedule for AI Behavior Logs

AI behavior logs (as defined in `GOV-ETH-001`, Section 5) are governed here for completeness:

| Stage | Default | User Override |
|---|---|---|
| Active retention | 90 days rolling | User may extend to indefinite |
| Deletion | Automatic at 90-day rolling mark | User may delete individual entries or all entries at any time |
| Account deletion | All behavior logs deleted within 30 days of account deletion request | N/A |

### 3.5 Confidence Decay and Archival

Nodes with a `confidenceWeight` that falls below **0.15** for a sustained period of **180 consecutive days** without reinforcement are eligible for automatic transition to `Archived` tier. This transition:

1. Is surfaced to the user as a notification ("These memories haven't been referenced in a while — would you like to archive or review them?")
2. Requires **explicit user confirmation** before the transition executes
3. Is never silent or automatic without consent

The AI may not archive any node classified as `Sensitive` or `Sealed` under any automated pathway. These classifications require explicit user action to change tier.

### 3.6 Critical Memory Preservation

When a node transitions to `Summarized` or `Archived` tier, and the node is classified as `Sensitive` or carries a high `confidenceWeight` (≥ 0.80 at time of transition), the system must offer the user the option to generate a **narrative preservation summary**: a first-person, human-readable prose account of the memory suitable for long-term preservation independent of the structured graph.

Narrative preservation summaries are:
- Stored as a distinct node type (`memoryType: Narrative`)
- Retained in `FullRetention` tier indefinitely unless the user deletes them
- Exportable in plain text and JSON-LD formats

### 3.7 Deletion Procedures

#### 3.7.1 Standard Deletion Flow

1. User initiates deletion of one or more nodes (individually or in bulk) via the Memory Manager interface
2. System transitions node(s) to `PendingDeletion` tier and displays a clear confirmation screen listing exactly what will be deleted
3. A **14-day grace period** begins; the node is excluded from active AI context during this period but is recoverable by the user
4. At the end of the grace period, or upon user-initiated immediate deletion confirmation, the system executes the deletion procedure:
   - All encrypted node content and metadata are overwritten with cryptographic zeros on all local storage layers
   - A deletion record (node ID, deletion timestamp, tier at deletion — no content) is written to the audit log
   - A cloud deletion request is issued; cloud-layer deletion completes within **72 hours** of the request
   - Associated edges are removed from the graph index
5. User receives a deletion confirmation notification

#### 3.7.2 Immediate Deletion Option

Users may bypass the 14-day grace period by explicitly confirming immediate deletion through a two-step confirmation UI (not a single click). Immediate deletion is irreversible and is clearly labeled as such.

#### 3.7.3 Cascade Deletion

When a node is deleted, the system evaluates associated edges:
- Edges where the deleted node is the sole source or target are automatically deleted
- Edges that connect two surviving nodes are retained
- The user is informed of cascade effects before confirming deletion of high-connectivity nodes (nodes with more than 10 edges)

### 3.8 Right to Erasure (Full Account Deletion)

Users have the unconditional right to request complete erasure of all their data. This right is not conditional on account standing, subscription status, or any other factor.

#### 3.8.1 Erasure Procedure

1. User submits an account deletion and erasure request via the in-app Account Settings or by contacting the maintainers (open an issue)
2. The operator acknowledges the request within **24 hours** with a unique request reference number
3. The user is offered a **30-day export window** before final erasure. During this window the user may download a full data export. This window is offered, not imposed — the user may waive it and proceed immediately.
4. Erasure execution begins at the end of the export window (or immediately if waived):
   - All memory nodes, edges, behavior logs, conversation transcripts, summarizations, and user preferences are deleted from all local and cloud storage layers
   - All encryption keys stored in operator-managed key infrastructure are destroyed
   - Cloud-layer deletion is certified complete within **30 days** of erasure execution
5. The operator provides a written erasure confirmation within **35 days** of the original request

#### 3.8.2 Retained Records

Upon erasure, the operator retains only:
- The erasure request audit record (request date, completion date, reference number — no content)
- Financial transaction records required by applicable law (e.g., billing history), retained only for the legally mandated period

These retained records do not include any memory content, conversation data, or behavioral data.

#### 3.8.3 Erasure and Third Parties

If any user data has been shared with third-party services through explicitly user-authorized integrations, the operator will:
1. Notify those services of the erasure request within **48 hours**
2. Provide the user with a list of all third parties notified
3. Request confirmation of deletion from each party within 30 days

The operator cannot guarantee erasure enforcement on third-party systems but will document all notifications and confirmations in the erasure audit record.

---

## 4. Portability Requirements

### 4.1 Governing Principle

Data portability is a first-class feature, not a compliance checkbox. Users must be able to export a complete, well-structured, human-readable, and machine-readable representation of their memory graph at any time, in formats that allow import into other systems without requiring the operator software.

### 4.2 Mandatory Export Formats

All user exports must be available in both of the following formats simultaneously:

| Format | Standard | Use Case |
|---|---|---|
| **JSON-LD** | W3C JSON-LD 1.1 | Machine-readable, semantically typed, importable into standard RDF tooling and graph databases |
| **RDF/Turtle** | W3C RDF 1.1 Turtle | Compact, human-readable RDF serialization; compatible with Amazon Neptune, Apache Jena, and all standard triple stores |

Proprietary-only export formats are prohibited as the sole export option. The operator may offer additional formats (e.g., plain-text narrative, CSV for tabular data) as supplementary options, but JSON-LD and RDF/Turtle must always be available.

### 4.3 Export Package Specification

A complete the operator data export package must contain:

```
albuddy-export-{userId}-{timestamp}/
├── manifest.json               # Package metadata (version, date, contents inventory)
├── schema/
│   ├── albuddy-ontology.ttl    # Current ontology version used for this export
│   └── albuddy-ontology.json   # JSON-LD context file for this export
├── memory-graph/
│   ├── nodes.jsonld            # All memory nodes in JSON-LD format
│   ├── nodes.ttl               # All memory nodes in RDF/Turtle format
│   ├── edges.jsonld            # All relationship edges in JSON-LD format
│   └── edges.ttl               # All relationship edges in RDF/Turtle format
├── conversations/
│   ├── raw/                    # Raw conversation logs still within retention window
│   │   └── {sessionId}.jsonld
│   └── summaries/              # All conversation summary nodes
│       └── {nodeId}.jsonld
├── narratives/
│   └── {nodeId}.txt            # Plain-text narrative preservation summaries
├── behavior-logs/
│   └── behavior-logs.jsonld    # AI behavior logs within retention window
├── preferences/
│   └── user-preferences.json   # User settings, retention rules, privacy classifications
└── README.txt                  # Plain-English guide to the export package contents
```

### 4.4 Export Package Manifest Format

```json
{
  "exportId": "<uuid>",
  "userId": "<userId>",
  "exportedAt": "<ISO 8601>",
  "schemaVersion": "1.0.0",
  "exportSchemaVersion": "1.0.0",
  "contentsSummary": {
    "totalMemoryNodes": 0,
    "totalEdges": 0,
    "totalConversationRawLogs": 0,
    "totalConversationSummaries": 0,
    "totalNarratives": 0,
    "totalBehaviorLogEntries": 0
  },
  "integrityHashes": {
    "nodes.jsonld": "<sha256>",
    "edges.jsonld": "<sha256>"
  },
  "encryptionStatus": "decrypted | encrypted",
  "exportedBy": "user | admin_with_consent | legal_request"
}
```

### 4.5 Export Schema Versioning

- Export schemas are versioned independently of application versions, using semantic versioning (`MAJOR.MINOR.PATCH`)
- Every export package embeds the schema version used at export time
- the operator maintains published migration guides for all `MAJOR` version changes to export schemas
- Export schema versions are maintained for a minimum of **5 years** after the version is superseded, to ensure users can always interpret historical exports
- Schema changelogs are published at `docs/governance/export-schema-changelog.md`

### 4.6 Export Tooling Requirements

The data export tool must satisfy the following requirements:

| Requirement | Specification |
|---|---|
| **Availability** | Accessible at any time from the in-app Account Settings; no wait period or approval gate |
| **Completeness** | Must export 100% of user data across all retention tiers, including Archived nodes and Pending Deletion nodes still within grace period |
| **Integrity verification** | Must produce SHA-256 checksums for all exported files, included in the manifest |
| **Encryption option** | User may request an encrypted export bundle (AES-256, user-supplied passphrase); default is unencrypted |
| **Delivery** | Direct download to device; large exports (>500 MB) may be prepared asynchronously with a notification when ready (maximum preparation time: 4 hours) |
| **No account deletion required** | Exporting data must not require or trigger account deletion |
| **Frequency** | No limit on export frequency; minimum 1 export per 24-hour period guaranteed without throttling |
| **Migration tooling** | A separate import/migration tool must be able to round-trip a JSON-LD or RDF/Turtle export back into a valid the memory graph |

### 4.7 Portability Testing Schedule

| Test | Frequency | Owner | Pass Criteria |
|---|---|---|---|
| Export completeness audit | Quarterly | Engineering lead | Automated test confirms all node types, edge types, and data categories appear in export output for synthetic test accounts |
| Schema validation | On every schema version change | Engineering lead | All exported JSON-LD validates against the published JSON-LD context; all Turtle validates as well-formed RDF |
| Round-trip import test | Quarterly | Engineering lead | A full export from a test account can be imported into a clean account with zero data loss; node count, edge count, and content checksums match |
| Cross-tool compatibility test | Semi-annual | Engineering lead | Exports successfully load in at least two independent open-source RDF tools (e.g., Apache Jena, Protégé) |
| Large-account performance test | Semi-annual | Engineering lead | Export of a synthetic account with 100,000+ nodes completes within the 4-hour SLA |
| User-facing export flow audit | Quarterly | Product + Engineering | A human tester completes a full export without consulting documentation; no dark patterns, misleading labels, or hidden steps |

---

## 5. Memory Schema Evolution Governance Process

### 5.1 Governing Principle

The memory ontology is a living system. As the platform learns what kinds of memories matter to users, the schema will need to expand, refine, and occasionally restructure. This evolution must be AI-assisted but human-governed: the AI may observe patterns and propose changes; humans decide what changes are adopted and when.

The canonical ontology starts minimal and grows deliberately. Schema stability is a user trust asset — unnecessary or hasty changes impose migration burden and risk on every user's memory graph.

### 5.2 Schema Change Types

| Change Type | Examples | Risk Level |
|---|---|---|
| **Additive expansion** | New `memoryType` value, new edge `relationshipType`, new optional metadata field | Low |
| **Semantic refinement** | Clarifying the definition of an existing type without changing its scope | Low |
| **Metadata restructuring** | Renaming a field, splitting a field into multiple fields, merging fields | Medium |
| **Core type modification** | Changing the scope or definition of a core `memoryType` | High |
| **Graph model refactoring** | Restructuring how nodes and edges relate (e.g., collapsing two node types into one) | High |
| **Provenance model change** | Adding, removing, or redefining `provenance` values | High |

### 5.3 Proposal Sources

Schema change proposals may originate from:

- **AI observation:** The AI identifies a pattern across many memory sessions that the current schema cannot represent accurately, and generates a structured proposal
- **Engineering team:** A developer identifies a technical gap or modeling problem
- **User feedback:** Aggregated user feedback (anonymized) identifies that a category of memory is frequently mislabeled or missing
- **Governance review:** A quarterly or annual review identifies schema drift or inconsistency

All proposals, regardless of source, enter the same governance pipeline.

### 5.4 Proposal Format

Every schema change proposal must be documented as a Schema Change Request (SCR) with the following fields:

```json
{
  "scrId": "<uuid>",
  "proposalDate": "<ISO 8601>",
  "proposedBy": "AI | Engineering | UserFeedback | GovernanceReview",
  "changeType": "<from Section 5.2>",
  "title": "<short description>",
  "rationale": "<why this change is needed>",
  "proposedChange": {
    "description": "<plain-language description of the change>",
    "ontologyDiff": "<diff against current ontology>",
    "affectedNodeTypes": ["<list>"],
    "affectedEdgeTypes": ["<list>"],
    "estimatedAffectedNodes": "<number or range>"
  },
  "migrationPlan": {
    "backwardCompatible": true,
    "migrationScript": "<reference to migration tooling or null>",
    "rollbackPlan": "<how to undo this change if needed>"
  },
  "approvalTier": "<Auto | Staged | Manual>",
  "status": "Proposed | UnderReview | StagedRollout | Approved | Rejected | Rolled Back"
}
```

### 5.5 Approval Tiers

#### Tier 1: Auto-Approved

Changes that meet **all** of the following criteria may be auto-approved without human review:

1. Change type is `Additive expansion` only
2. The change adds an optional field or new enum value — it does not modify or remove any existing element
3. No existing node data requires migration (backward compatible by definition)
4. The change is on a pre-defined expansion pathway documented in the ontology spec (e.g., a new `memoryType` that is a subclass of an existing, pre-approved extensible type)
5. The estimated number of affected nodes is zero (adding a new type cannot retroactively affect existing nodes)

**Process:** The AI or engineering team submits the SCR. An automated governance check confirms all five criteria. The change is applied to the staging ontology, validated by schema tests, and promoted to production within **48 hours**. The SCR is logged in the governance audit trail.

**Human notification:** The CTO and the maintainers are notified of auto-approved changes in the weekly governance digest. Either may raise an objection within **7 days**; if an objection is raised, the change is immediately rolled back and the SCR is re-classified as Tier 2.

#### Tier 2: Staged Rollout

Changes that do not qualify for Tier 1 and do not require Tier 3 review proceed through staged rollout:

**Staging criteria (any of the following trigger Tier 2):**
- Change type is `Metadata restructuring`
- The change affects existing nodes (estimated affected nodes > 0)
- A migration script is required
- The change modifies an existing optional field or enum value

**Process:**

1. SCR is submitted and reviewed by the CTO (or designated schema governance lead) within **5 business days**
2. If the CTO approves proceeding to staging, the change is deployed to a limited rollout population (maximum 5% of accounts, randomly selected from opted-in beta participants) for a **21-day observation period**
3. During the observation period, the following metrics are monitored:
   - Migration error rate (target: < 0.1%)
   - User-reported memory display errors related to affected node types
   - AI-reported retrieval accuracy on affected nodes (measured against a held-out test set)
4. At the end of the observation period, the CTO reviews the metrics and makes a proceed/rollback decision
5. If proceeding, the change is applied to all accounts over a rolling **7-day deployment window**
6. If rolling back, the migration is reversed using the rollback plan in the SCR; affected beta accounts are restored to their prior state within **24 hours**

**Timeline:** Tier 2 changes complete in a minimum of 28 days (5-day review + 21-day staging + up to 7-day deployment) and a maximum of 60 days before a rollback decision must be made.

#### Tier 3: Manual Review

Changes that meet any of the following criteria require full manual review with explicit governance sign-off:

- Change type is `Core type modification`, `Graph model refactoring`, or `Provenance model change`
- The change affects more than 20% of all user memory nodes
- The change modifies the `privacyClassification` model or `encryptionKeyRef` handling
- The change could affect a user's right to erasure or data portability
- Engineering or the AI flags the change as having uncertain semantic consequences
- A Tier 2 staged rollout produced unexpected results requiring root-cause analysis before proceeding

**Process:**

1. SCR is submitted and assigned a governance review panel consisting of: CTO, the maintainers, and a senior engineer not involved in the proposal
2. Panel has **10 business days** to review the SCR, request additional analysis, and reach a decision
3. The the maintainers must sign off on all Tier 3 changes (in addition to the CTO) before any staging begins
4. If approved, the change proceeds through a Tier 2-equivalent staged rollout process, plus an additional **30-day post-deployment monitoring period** before the SCR is closed
5. If the panel cannot reach consensus within the review window, the SCR is automatically escalated to the CEO for a final decision within **5 additional business days**
6. Rejected SCRs are documented with a rationale and closed; they may be resubmitted after **90 days** if the underlying concern is addressed

**User notification:** For Tier 3 changes that affect the schema in a user-visible way (e.g., existing memories are re-categorized or display differently), users must be notified in advance of the deployment, in plain language, describing what is changing and why. Notification must be sent at least **14 days** before the change reaches any production account.

### 5.6 Rollback Procedures

Every approved schema change must have a documented rollback plan before approval. Rollback is triggered when:

- A staged rollout produces an error rate above the defined threshold
- A post-deployment monitoring period surfaces unexpected data integrity issues
- The CTO, the maintainers, or CEO orders a rollback for any reason
- A user-reported issue reveals a critical defect in the deployed change

**Rollback SLAs:**

| Tier | Maximum Time to Initiate Rollback | Maximum Time to Complete Rollback |
|---|---|---|
| Tier 1 | 7 days (upon objection) | 24 hours after initiation |
| Tier 2 (staging) | Immediately upon breach of error threshold | 24 hours after initiation |
| Tier 2 (production) | 4 hours after trigger | 48 hours after initiation |
| Tier 3 (staging or production) | 2 hours after trigger | 48 hours after initiation |

**Post-rollback:** All rolled-back SCRs are logged with a post-mortem. The post-mortem must be completed within **10 business days** of the rollback and is included in the quarterly governance review.

### 5.7 Ontology Version Control

- The canonical ontology is version-controlled with the library
- Every change, regardless of tier, produces a new semantic version of the ontology
- The version embedded in every exported user data package must correspond to the ontology version active at export time
- Ontology history is never deleted; all prior versions remain accessible for export interpretation

---

## 6. Replication and Disaster Recovery Policy

### 6.1 Architecture Overview

The operator uses a local-first hybrid architecture:

| Layer | Technology | Role |
|---|---|---|
| **On-device store** | Encrypted graph database (local) | Primary active store; always-first source of truth for the user's device |
| **Cloud sync hub** | Amazon Neptune (managed graph database) | Long-term persistence, cross-device sync, and backup anchor |
| **Key management** | User-controlled keys (described in Section 6.7) | Encryption layer applied before any data leaves the device |

Data flows from device to cloud opportunistically (see Section 6.4). The cloud layer never holds unencrypted data. A user whose device is the only device and who never syncs still has a fully functional the operator experience — cloud sync is additive, not required.

### 6.2 Recovery Objectives

| Metric | Target | Rationale |
|---|---|---|
| **Recovery Point Objective (RPO)** | ≤ 24 hours | Maximum acceptable data loss in a full cloud-layer failure; assumes the last completed sync was within 24 hours |
| **Recovery Time Objective (RTO)** | ≤ 4 hours | Maximum acceptable time to restore cloud-layer service after a declared disaster |
| **Device-only RPO** | 0 hours | Local-first architecture means the user's device is always current; no data loss on device unless the device itself is lost |
| **Cross-device sync RPO** | ≤ 72 hours | After a sync event, changes are visible on other devices within 72 hours under degraded conditions; target under normal conditions is ≤ 1 hour |

These are minimum targets. The engineering team must define and operate to tighter operational SLOs that provide headroom against the governance RPO/RTO floor.

### 6.3 Backup Schedule

| Backup Type | Frequency | Retention Window | Storage |
|---|---|---|---|
| **Neptune automated snapshot** | Daily | 35 days | Neptune-managed; geographically redundant |
| **Neptune continuous backup (PITR)** | Continuous | 35-day point-in-time recovery window | Neptune-managed |
| **Weekly full snapshot** | Weekly (Sunday 02:00 UTC) | 12 weeks | Separate S3 bucket with independent encryption and access controls |
| **Monthly archive snapshot** | First Sunday of each month | 24 months | Deep archive storage; access requires documented authorization |
| **Pre-migration snapshot** | Before every Tier 2 or Tier 3 schema migration | Until 30 days post-migration success confirmation | Neptune-managed + S3 copy |

All backup artifacts are encrypted at rest using the same encryption standards as the primary datastore. Backup encryption keys are managed independently from operational keys to prevent a single-key compromise from affecting both.

### 6.4 Sync Policy

#### 6.4.1 Sync Triggers

Cloud synchronization is initiated opportunistically to minimize battery and data consumption:

| Trigger | Condition |
|---|---|
| **Idle + Wi-Fi + charging** | Primary trigger; device is on Wi-Fi, plugged in, and screen is off |
| **Idle + Wi-Fi (not charging)** | Secondary trigger; applies when primary trigger has not fired within 12 hours |
| **Explicit user sync** | User manually initiates sync from settings at any time |
| **Post-session grace** | 30 minutes after an active session ends, a lightweight delta sync is attempted if Wi-Fi is available |
| **Cellular (user opt-in)** | Users may opt in to cellular sync; disabled by default |

#### 6.4.2 Sync Conflict Resolution

When two devices produce conflicting edits to the same node (concurrent modification):

1. Both versions of the conflicting node are preserved as distinct versions
2. The user is notified of the conflict at next app open on either device
3. The user is presented with a clear, human-readable diff and asked to choose the authoritative version or merge manually
4. The AI may offer a suggested merge if the conflict is resolvable (e.g., two sets of appended metadata that do not contradict each other), but the user must confirm any merge
5. Unresolved conflicts are retained as dual-version nodes for a maximum of **30 days**, after which the user is prompted again; the conflict is never resolved silently by the system

#### 6.4.3 Sync Scope

The sync layer synchronizes:
- All memory nodes and edges across all retention tiers
- User preferences and privacy classification settings
- AI behavior logs (subject to user-configured retention window)
- Ontology version metadata

The sync layer does not synchronize:
- User-controlled private keys (keys never leave the device to the cloud layer unencrypted)
- Sealed nodes (nodes with `privacyClassification: Sealed` are excluded from cloud sync unless the user explicitly overrides this)

### 6.5 Multi-AZ Replication

The Neptune cluster operates in Multi-AZ configuration:

- A minimum of two Availability Zones are active at all times
- Read replicas are maintained in each active AZ
- Writes are acknowledged only after being committed to at least two AZs
- Automated failover to a healthy replica occurs within **30 seconds** of a primary instance failure (Neptune standard)
- Regional failover (cross-region) is a manual procedure requiring CTO authorization; target activation time for regional failover is ≤ 2 hours

### 6.6 Disaster Recovery Procedures

#### 6.6.1 Failure Classification

| Severity | Definition | Recovery Path |
|---|---|---|
| **P1 — Full cloud outage** | Neptune cluster unavailable; no reads or writes possible | Activate DR procedure (Section 6.6.2) |
| **P2 — Partial degradation** | Cloud layer available but degraded (high latency, partial write failures) | Engineering incident response; no DR declaration required unless degradation persists > 4 hours |
| **P3 — Sync failure** | Cloud sync not completing but local-first operation unaffected | Engineering triage; user impact is delayed cross-device sync only |
| **P4 — Data corruption** | Integrity checks fail on a subset of nodes | Targeted restore from PITR; scope assessment required within 2 hours |

#### 6.6.2 P1 Full Cloud Outage — DR Activation Procedure

1. **Detection and declaration (target: ≤ 15 minutes):** Automated monitoring alerts the on-call engineer. If the outage is confirmed as P1, the CTO (or designated backup) declares a DR event and notifies the engineering incident channel.
2. **User communication (target: ≤ 30 minutes after declaration):** Users are notified via in-app banner and status page that cloud sync is unavailable; local-first operation continues unaffected.
3. **Failover assessment (target: ≤ 45 minutes):** Engineering assesses whether Neptune Multi-AZ automatic failover has resolved the issue. If not, manual failover or regional failover is initiated.
4. **Regional failover (if required, target: ≤ 2 hours):** CTO authorizes promotion of the standby region. Neptune PITR is used to restore to the most recent clean state within the RPO window.
5. **Key management validation (target: ≤ 2 hours):** Before restoring user data access, engineering verifies that the key management service is operational and that encrypted data can be decrypted correctly. A canary account is used for validation before general access is restored.
6. **Data integrity verification (target: ≤ 3 hours):** Automated integrity checks run against the restored dataset. Any nodes failing integrity checks are quarantined and flagged for user notification.
7. **Service restoration (target: ≤ 4 hours):** Cloud sync is re-enabled. Users are notified of restoration. Sync backlog processing begins.
8. **Post-incident review (target: ≤ 5 business days):** A full post-mortem is completed and published internally. Findings are included in the quarterly governance review. Systemic issues that cannot be resolved within 30 days are escalated to the EAB.

#### 6.6.3 P4 Data Corruption — Targeted Restore Procedure

1. Engineering identifies the corruption scope (which node IDs, which time window)
2. Neptune PITR is used to restore a point-in-time snapshot of affected records
3. Affected users are notified within **24 hours** that a data integrity event occurred, what data was affected, and what recovery action was taken
4. If any user data cannot be fully recovered, users are notified explicitly and offered a full data export of recovered data plus a deletion/erasure option

### 6.7 Key Management Considerations for DR

End-to-end encryption with user-controlled keys creates a specific DR challenge: encrypted data without accessible keys is permanently unrecoverable. The following rules govern key management in the context of DR:

| Rule | Specification |
|---|---|
| **Keys never stored on cloud layer unencrypted** | User-controlled keys are never transmitted to or stored by the operator cloud infrastructure in plaintext |
| **Key backup is user responsibility** | the operator provides a secure, documented key backup mechanism (e.g., encrypted key export to a user-chosen location) and strongly encourages users to use it during onboarding |
| **Key backup tooling** | The app includes a key backup wizard that guides users through exporting their key to a secure location external to the operator; this is presented at account creation and periodically in the security settings |
| **Key loss consequences disclosed** | Users are explicitly informed during onboarding and in the key backup flow that loss of their private key means loss of access to their encrypted memories; the operator cannot recover data without the key |
| **Backup encryption keys** | Backup snapshots are encrypted with a separate, operator-managed key that is independent of user keys; this allows backup integrity checks and DR restoration without user key material |
| **Key rotation** | Users may rotate their encryption key at any time; the platform re-encrypts all stored data under the new key transparently; the old key is destroyed after re-encryption is verified |
| **Staff access prohibition** | No the operator staff member may access user-encrypted memory data; the architecture must make this technically impossible, not merely policy-prohibited |

### 6.8 DR Testing Cadence

| Test | Frequency | Owner | Pass Criteria |
|---|---|---|---|
| **Neptune failover drill** | Quarterly | Engineering lead | Automatic Multi-AZ failover completes within Neptune SLA; no data loss confirmed by checksum comparison |
| **PITR restoration test** | Quarterly | Engineering lead | A point-in-time restore of a synthetic test cluster completes within 2 hours; restored data matches source checksums |
| **Full DR tabletop exercise** | Semi-annual | CTO + Engineering | Engineering team walks through the full P1 DR procedure against a simulated outage scenario; gaps are documented and remediated within 30 days |
| **Regional failover test** | Annual | CTO + Engineering | Full regional failover to standby region is executed against non-production infrastructure; RTO target is validated |
| **Key management DR test** | Semi-annual | Engineering lead | Key rotation and key-loss recovery procedures are validated in a test environment; data accessibility confirmed post-rotation |
| **User notification test** | Semi-annual | Engineering + Product | Automated user notification system is verified to deliver in-app and status page updates within the required SLAs for a P1 scenario |

All DR test results are documented and retained for a minimum of **2 years**. Failures are tracked as engineering issues with mandatory resolution timelines before the next test of the same type.

---

## 7. Compliance and Cross-Policy Alignment

### 7.1 Relationship to Other Governance Policies

| Policy | Relationship |
|---|---|
| `GOV-ETH-001` — Ethical AI Behavior Governance Policy | AI behavior logs governed in this policy (Section 3.4) must conform to the log format and retention rules defined in `GOV-ETH-001`, Section 5. Training data prohibition in `GOV-ETH-001`, Section 5.4 applies to all memory data. |
| `GOV-LIF-001` — Lifecycle & Age-Appropriate Governance Policy | Memory privacy classifications and guardian access controls (Section 2.3) must be consistent with the phase-based guardian control framework defined in `GOV-LIF-001`, Section 4. Guardian-initiated memory deletion is governed here (Section 3.7); guardian authority to initiate deletion is governed in `GOV-LIF-001`. |
| `GOV-PRI-001` — User Sovereignty & Privacy Policy | This policy defers to `GOV-PRI-001` on the broader definition of user data rights and consent framework. The right-to-erasure procedure in Section 3.8 must align with `GOV-PRI-001`. |

### 7.2 Regulatory Alignment

This policy is designed to satisfy the following regulatory requirements, though legal compliance review is required in each applicable jurisdiction:

| Regulation | Relevant Provision |
|---|---|
| GDPR (EU) | Right to erasure (Article 17), Right to data portability (Article 20), Data minimization (Article 5) |
| CCPA/CPRA (California) | Right to delete, Right to know, Right to data portability |
| COPPA (US) | Parental control over minor user data; deletion upon guardian request |
| PIPEDA (Canada) | Access and correction rights, retention limitation |

### 7.3 All-Team Obligation

Every person or system that designs, builds, configures, or operates any component of the memory system is obligated to comply with this policy. This includes:
- Engineers implementing storage, sync, and export features
- AI teams building summarization, consolidation, and schema proposal systems
- Operations teams managing cloud infrastructure
- External contractors and integration partners with any access to memory data infrastructure

### 7.4 Violation Reporting

Suspected violations of this policy may be reported to the maintainers (open an issue). Reports are reviewed by the CTO and the maintainers within **5 business days**. Reports involving potential data loss or unauthorized access are escalated to a 24-hour response track.

---

## 8. Review Cadence and Ownership

### 8.1 Review Schedule

| Review Type | Frequency | Owner | Output |
|---|---|---|---|
| Quarterly internal review | Quarterly | CTO + the maintainers | Internal audit covering: retention schedule compliance, export tool status, schema SCR log, DR test results |
| EAB review | Semi-annual | EAB Chair | Public summary findings covering data governance and memory stewardship practices |
| Full policy revision | Annual | CTO + the maintainers + EAB | Versioned policy update |
| Emergency review | As needed (24h trigger) | CTO (primary), the maintainers (co-lead) | Incident report + remediation plan |

### 8.2 Emergency Review Triggers

An emergency review is triggered immediately by:
- A data breach or unauthorized access to any user memory data
- A DR event that exceeds RPO or RTO targets
- Discovery of a data deletion failure (data not being deleted when required)
- A regulatory investigation related to data retention or portability
- A schema change that produces data integrity failures in production
- Any incident where user-controlled keys may have been exposed

### 8.3 Policy Versioning

This policy is versioned. All changes require:
1. A documented rationale
2. CTO sign-off
3. the maintainers co-sign on any changes to ethical data handling provisions
4. EAB notification (EAB has **14 days** to object before changes take effect for non-emergency revisions)
5. Version increment and changelog entry

Version history is maintained at `docs/governance/CHANGELOG.md`.

### 8.4 Ownership

**Primary owner:** Chief Technology Officer (CTO)
**Ethical data provisions co-owner:** the maintainers
**Secondary owner:** CEO (escalation path when CTO is unavailable)
**EAB liaison:** EAB Chair

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Memory steward** | the operator's operational role with respect to user memory: custodian and operator, not owner |
| **Memory node** | A single unit in the memory graph representing one memory entity (Experience, Lesson, Conversation, Belief, Relationship, or Skill) |
| **Retention tier** | The current archival state of a memory node: Full Retention, Summarized, Archived, Pending Deletion, or Deleted |
| **Confidence weight** | A float value [0.0–1.0] representing the estimated current relevance and freshness of a memory node |
| **Decay rate** | The rate at which a node's confidence weight decreases over time without reinforcement |
| **Sealed node** | A memory node with `privacyClassification: Sealed`; excluded from AI processing and cloud sync |
| **Schema Change Request (SCR)** | The structured proposal document used to govern changes to the memory ontology |
| **Approval tier** | The governance pathway for an SCR: Tier 1 (Auto), Tier 2 (Staged), or Tier 3 (Manual) |
| **RPO** | Recovery Point Objective — the maximum acceptable data loss measured in time |
| **RTO** | Recovery Time Objective — the maximum acceptable time to restore service after a disaster |
| **PITR** | Point-in-Time Recovery — Neptune capability to restore data to any second within the backup retention window |
| **Local-first** | An architecture where the device is the primary data store and cloud is additive; full functionality does not require cloud connectivity |
| **Right to erasure** | The user's unconditional right to request complete deletion of all their data from all the operator systems |
| **JSON-LD** | JSON-based Linked Data format; W3C standard for structured, semantically typed data exchange |
| **RDF/Turtle** | Resource Description Framework serialization format; W3C standard; human-readable and widely supported |
| **Narrative preservation summary** | A first-person prose account of a memory, generated by AI and confirmed by the user, for long-term human-readable preservation |

---

## Appendix B: Related Policies

- `GOV-TECH-001` — [Technical Governance & Schema Evolution Policy](technical-governance-schema-evolution-policy.md)
- `GOV-ETH-001` — [Ethical AI Behavior Governance Policy](ethical-ai-behavior-policy.md)
- `GOV-PRI-001` — [User Sovereignty & Privacy Policy](user-sovereignty-privacy-policy.md)
- `GOV-LIF-001` — [Lifecycle & Age-Appropriate Governance Policy](lifecycle-age-appropriate-policy.md)

---

## Appendix C: Referenced Standards

| Standard | Authority | Use in This Policy |
|---|---|---|
| JSON-LD 1.1 | W3C | Mandatory export format |
| RDF 1.1 Turtle | W3C | Mandatory export format |
| ISO 8601 | ISO | Timestamp format for all log and metadata fields |
| UUID v4 | RFC 4122 | Node and edge identifier format |
| AES-256 | NIST | Minimum encryption standard for all stored and exported data |
| SHA-256 | NIST | Integrity hash standard for export manifests |

---

*This is a living document. Revisions are tracked in `docs/governance/CHANGELOG.md`.*
