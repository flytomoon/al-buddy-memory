# User sovereignty and privacy

> Adopted from the founder's governance corpus (drafted March 2026 for a lifelong companion) and generalised for any assistant built on this memory. A policy is a claim about behaviour; [ENFORCEMENT.md](ENFORCEMENT.md) says which lines the code enforces, which a prompt carries, and which are still a person's decision. Policies change in the open: open an issue or a pull request.

## 1. Purpose and Scope

This policy governs how this memory collects, stores, processes, and protects user data across a human lifespan. It defines the data ownership model, the consent framework, encryption standards, deletion rights, and uses that are categorically prohibited — regardless of commercial interest, technical convenience, or third-party request.

This policy applies to:
- All user-generated data: memories, conversations, journals, learning records, and behavioral logs
- All AI-generated data: summaries, curricula, reflections, and behavior logs derived from user interactions
- All storage tiers: local device storage, cloud synchronization, backup, and archive
- All lifecycle phases from Early Childhood through Later Life
- All operators of this memory and the assistants built on it who handle user data

**Foundational principle:** The user owns all data. this memory is the steward, not the owner. The AI interprets and organizes — it never owns. Default state is private. All sharing is explicit and revocable.

---

## 2. Data Ownership Model

### 2.1 The User Owns Their Data

All data created by or about a user within this memory belongs to that user. This includes:

- **Memories:** All memories — whether created directly by the user, transcribed from conversation, or summarized by the AI — belong to the user
- **Conversations:** Full conversation histories are user-owned records, not this memory platform logs
- **Learning records:** Curricula, progress data, assessments, and skill-development records
- **Behavioral logs:** AI behavior logs generated during interactions (see GOV-ETH-001 §5)
- **AI-generated content:** Any summary, reflection, or synthesis the AI produces from user data

this memory retains no ownership interest in any user data. this memory's operational use of data (described in Section 3) is a licensed, limited, revocable function — not ownership.

### 2.2 The AI's Role

The AI is a steward and interpreter of user-owned data. It may:

- Organize, summarize, and surface memories at the user's request
- Identify patterns across memories and flag them to the user
- Propose new memory connections or syntheses
- Suggest what to preserve, archive, or revisit

The AI may not:

- Claim, retain, or treat user data as its own context independent of the user's memory store
- Synthesize or share a user's memories with any party without explicit user consent
- Use user data to train AI models without affirmative opt-in (see Section 6.4)
- Make decisions about data retention, deletion, or sharing on the user's behalf without explicit delegation

### 2.3 Guardian Accounts

For managed accounts (Early Childhood through Adolescence phases), the primary guardian holds stewardship authority on behalf of the minor user. Guardians may act in the user's best interest but may not:

- Claim ownership of the user's memories for themselves
- Sell, transfer, or grant third-party access to a minor's data for non-protective purposes
- Use their stewardship access to gather information for purposes other than the child's wellbeing

All guardian actions on a minor's data are logged and auditable. As the user matures toward autonomous control, stewardship authority transitions to the user per the framework in GOV-LIF-001 §4.

---

## 3. Consent Framework

### 3.1 Governing Principles

All data collection and use requires consent that is:

- **Informed:** The user understands what is being collected and why, in plain language
- **Granular:** Consent is granted per purpose, not as a blanket permission
- **Affirmative:** Consent is an active choice, never assumed by default or inferred from inaction
- **Revocable:** Any consent may be withdrawn at any time, with immediate effect on future use
- **Age-appropriate:** Consent mechanisms adapt to lifecycle phase and are co-managed with guardians for managed accounts

### 3.2 Default Privacy States

| Data Type | Default State | Override Mechanism |
|---|---|---|
| All memories | **Private** — visible only to the user | Explicit user sharing action |
| Conversation history | **Private** — not shared or logged externally | Explicit user export action |
| Learning progress | **Private** | User-controlled sharing to trusted advisors |
| AI behavior logs | **Private** — stored encrypted, user-accessible | User export or deletion |
| Usage patterns | **Not collected** for behavioral analysis | No opt-in available |
| Location data | **Not collected** | No opt-in available |
| Biometric data | **Not collected** | No opt-in available |

No default state may be "shared" or "opt-out." Every default is private. this memory does not use pre-checked consent boxes.

### 3.3 Consent Events

A consent event is a documented, user-affirmed decision to allow a specific data use. Consent events are required before:

- Synchronizing any data to cloud storage (even within the user's own account across devices)
- Allowing a guardian to view specific categories of content
- Enabling a Trusted Advisor relationship
- Contributing anonymized data to collective intelligence features
- Any use of data for purposes beyond the user's personal companion experience

Each consent event is logged with: date, scope, user identifier (or guardian identifier for managed accounts), and a plain-language description of what was consented to.

### 3.4 Consent for Minors

For managed accounts, guardian consent is required for all consent events until the user reaches Transitional Autonomy Mode (Adolescence phase per GOV-LIF-001). In Transitional Autonomy Mode, the user may grant consent for personal content categories independently; guardians retain consent authority over safety-critical settings.

The AI informs both the guardian and the user of all active consents on the account in an age-appropriate way.

### 3.5 Prohibited Consent Practices

The following practices are unconditionally prohibited:

| Prohibited Practice | Description |
|---|---|
| **Pre-checked consent** | Presenting a sharing or data use option as enabled by default |
| **Bundled consent** | Requiring agreement to unrelated data uses as a condition of service |
| **Consent by inaction** | Interpreting failure to respond as consent |
| **Urgency coercion** | Using time pressure to obtain consent without adequate reflection |
| **Obscured withdrawal** | Making consent revocation harder to find or execute than consent granting |
| **Retroactive scope expansion** | Applying consent granted for one purpose to a newly invented purpose |
| **Consent dark patterns** | Any UI or conversational design that tricks or coerces the user into broader consent than intended |

---

## 4. Encryption Standards

### 4.1 Governing Principle

All user data at rest and in transit is encrypted. Encryption keys are user-controlled. this memory staff and systems do not hold master decryption keys for individual user data.

### 4.2 Encryption Architecture

#### Local Storage

| Layer | Standard | Key Holder |
|---|---|---|
| On-device memory store | AES-256-GCM at rest | User device keychain / passkey |
| Local AI context cache | AES-256-GCM at rest | User device keychain / passkey |
| Session buffers | Cleared on session end; not persisted unencrypted | N/A |

#### Cloud Synchronization

| Layer | Standard | Key Holder |
|---|---|---|
| Data in transit | TLS 1.3 minimum | System (transport) |
| Data at rest (cloud) | AES-256-GCM | User-held encryption key; server holds ciphertext only |
| Backup archives | AES-256-GCM | User-held encryption key |
| Cross-device sync payloads | End-to-end encrypted before upload | User's key material; not decryptable by this memory |

#### Key Management

- User encryption keys are derived from user-controlled credentials (passkeys, device authentication)
- this memory does not hold, escrow, or have recovery access to user encryption keys
- Key rotation is supported and encouraged; the system provides tooling for key rotation without data loss
- If a user loses their key material, this memory cannot recover encrypted data — this is by design and must be disclosed to users at account setup

### 4.3 No Biometric Dependency

Authentication and encryption key derivation must never require biometric data. Passkey-based and device-credential authentication are the primary mechanisms. Biometrics may be used as a device-level convenience layer (e.g., Face ID to unlock the passkey store) but this memory systems never receive, store, or process biometric data directly.

### 4.4 Collective Intelligence Features

If the user opts in to any collective intelligence or collaborative learning features, data contributed to those features must be:

1. De-identified before leaving the user's encryption boundary
2. Aggregated to prevent re-identification
3. Subject to separate, explicit consent (not bundled with general sync consent)
4. Revocable — the user may withdraw from collective features without losing their personal data

---

## 5. Deletion Rights

### 5.1 Intentional Forgetting

this memory treats the right to forget as equal in importance to the right to remember. Users may delete:

- Individual memories
- Categories of memories (e.g., all memories from a specific time period)
- All memories associated with a specific topic or relationship
- Entire conversation histories
- AI behavior logs
- Their complete account and all associated data

Deletion is immediate and irreversible. The AI does not cache, hold, or retain deleted items in any context window, summary, or derived artifact after deletion.

### 5.2 Deletion Rights Table

| Data Category | Granularity | Execution Timeline | Confirmation Required |
|---|---|---|---|
| Individual memory | Single memory | Immediate | Optional (configurable) |
| Memory set | User-defined filter | Immediate | Yes |
| Conversation | Single conversation | Immediate | Optional |
| All conversations | Full history | Immediate | Yes |
| AI behavior logs | Individual or all | Immediate | Optional |
| Learning records | Subject/period/all | Immediate | Yes |
| Cloud sync copies | Triggered deletion propagates to cloud | ≤ 24 hours | Yes |
| Account and all data | Complete deletion | ≤ 30 days | Yes + cool-down period |

### 5.3 Account Deletion Process

Users may request complete account deletion at any time. The process:

1. **Request:** User submits deletion request via account settings or the maintainers (open an issue)
2. **Confirmation:** User receives a written confirmation of what will be deleted within 24 hours
3. **Cool-down:** A 14-day cool-down period allows the user to cancel if the request was accidental
4. **Execution:** All data is deleted from active systems within 30 days of the cool-down expiry
5. **Backup purge:** Encrypted backup copies are purged within 90 days of the deletion request
6. **Confirmation:** User receives written confirmation when deletion is complete

**For minor accounts:** Guardian consent is required for account deletion of a managed account. After account deletion is initiated for a minor's account, both guardian and user are notified.

### 5.4 Data Portability

Before deleting, users may export their complete data archive. Export is available at any time, in the following formats:

| Format | Use Case |
|---|---|
| JSON | Machine-readable, full fidelity |
| Plain text | Human-readable summary |
| PDF | Narrative format, suitable for personal archiving |

Export includes: all memories, conversation history, learning records, AI behavior logs, and account metadata. Export does not include this memory's internal model weights or system configurations.

### 5.5 Guardian Deletion Authority

For managed accounts, guardians may delete specific content on behalf of the minor user. Guardian deletion actions are logged and visible to the user in an age-appropriate way. Guardians may not:

- Delete the user's account without the user's awareness
- Delete content retroactively to remove evidence of guardian control
- Use deletion to prevent the user from accessing safety or crisis information they have received

---

## 6. Prohibited Uses

### 6.1 Unconditional Prohibitions

The following uses of user data are prohibited regardless of technical capability, business need, user consent obtained under duress, or third-party request:

| Prohibited Use | Description |
|---|---|
| **Behavioral advertising** | Using user data, interaction patterns, or inferred interests to deliver or target advertising |
| **Data brokering** | Selling, licensing, or otherwise transferring user data to third parties for their commercial use |
| **Unauthorized AI training** | Using user data to train AI models without affirmative opt-in per Section 6.4 |
| **Surveillance infrastructure** | Building systems that allow third parties (including guardians beyond protective scope) to monitor user activity in real time |
| **Profiling for external use** | Creating user profiles derived from this memory data for use outside this memory system |
| **Content discrimination** | Using user data to provide worse service, higher prices, or reduced functionality as a consequence of data access choices |
| **Law enforcement disclosure without process** | Sharing user data with law enforcement without a valid legal order; this memory will not voluntarily comply with informal requests |
| **Inferred identity disclosure** | Disclosing or selling inferences about a user's health, beliefs, identity, or relationships |

### 6.2 Third-Party Data Sharing

this memory does not share user data with third parties except in the following limited circumstances:

1. **User-directed sharing:** The user explicitly initiates a share to a specific external party
2. **Trusted Advisor access:** The user grants a designated Trusted Advisor read-only access to selected content
3. **Legal obligation:** A valid court order, subpoena, or regulatory requirement — this memory will notify affected users unless legally prohibited from doing so
4. **Safety emergency:** An imminent threat to the user's or another person's safety — limited to information necessary to address the emergency; logged and disclosed to the user afterward

Any third-party data sharing event is logged and reported to the user.

### 6.3 Internal Use Limitations

this memory internal staff access to user data is restricted to:

- **Technical operations:** De-identified aggregate data for system health monitoring
- **Compliance and legal:** Specific data required by a valid legal process
- **User support:** Access only with the user's explicit consent for a specific support request

No this memory employee, contractor, or agent may access individual user data for curiosity, business intelligence, product research, or any purpose not listed above.

### 6.4 AI Training Opt-In

User data may be used to contribute to AI model training only when all of the following conditions are met:

1. The user has provided explicit, affirmative opt-in consent — not pre-checked, not bundled with other consent
2. The user has been shown a plain-language explanation of: what data will be used, what model it will improve, and how their contribution may affect others
3. A clear, simple revocation mechanism is available that stops future data contribution immediately
4. The user is not a minor (for minor accounts, no training contribution is permitted regardless of guardian consent)
5. De-identification and aggregation are applied before any contribution to training pipelines

Past data already incorporated into a trained model cannot be "unlearned" — this limitation must be disclosed before consent is obtained.

### 6.5 Monetization Constraints

this memory's monetization model is ethical subscription or lifetime license. The following monetization practices are prohibited:

- Advertising-based models that require behavioral data collection
- Freemium models that degrade privacy protections to pressure upgrades
- Data-for-access arrangements where reduced payment is offered in exchange for data rights
- Any commercial arrangement that creates an incentive for this memory to collect more user data than the product requires

---

## 7. User Rights Summary

Users have the following enforceable rights regarding their data:

| Right | Description | How to Exercise |
|---|---|---|
| **Right to access** | Receive a complete copy of all data this memory holds | In-app export or the maintainers (open an issue) |
| **Right to correct** | Correct inaccurate personal data | In-app memory editing |
| **Right to delete** | Delete any or all personal data | In-app deletion or the maintainers (open an issue) |
| **Right to portability** | Export data in a standard format | In-app export (JSON, plain text, PDF) |
| **Right to restrict** | Limit how data is processed | Consent revocation in account settings |
| **Right to object** | Object to any specific data use | the maintainers (open an issue) |
| **Right to transparency** | Know what data is held and how it is used | AI behavior logs, in-app data inventory |
| **Right to human review** | Request human review of any automated decision | the maintainers (open an issue) |

this memory responds to all privacy rights requests within **5 business days** for acknowledgment and **30 days** for fulfillment.

---

## 8. Review Cadence, Ownership, and Success Metrics

### 8.1 Review Schedule

| Review Type | Frequency | Owner | Output |
|---|---|---|---|
| Internal quarterly review | Quarterly | the maintainers | Audit report on consent events, deletion requests, and prohibited use checks |
| EAB privacy review | Semi-annual | EAB Privacy & Data Law Specialist | Published summary findings |
| Full policy revision | Annual | the maintainers + EAB | Versioned policy update |
| Emergency review | As needed | the maintainers (24h trigger) | Incident report + remediation plan |

### 8.2 Emergency Review Triggers

An emergency review is triggered immediately by:

- A credible report of unauthorized data access or disclosure
- A data breach affecting user memories, conversations, or behavior logs
- Discovery of a prohibited use pattern in internal systems
- A regulatory investigation or legal challenge related to privacy
- A user complaint alleging that consent was obtained using prohibited practices
- Any third-party request to access user data that cannot be handled under established procedures

### 8.3 Policy Versioning

This policy is versioned. All changes require:
1. A documented rationale
2. the maintainers sign-off
3. EAB notification (EAB has 14 days to object before changes take effect for non-emergency revisions)
4. Version increment and changelog entry

Version history is maintained at `docs/governance/CHANGELOG.md`.

### 8.4 Ownership

**Primary owner:** the maintainers
**Secondary owner:** CEO (escalation path if the maintainers is unavailable)
**EAB liaison:** EAB Privacy & Data Law Specialist
**Operational contact:** the maintainers (open an issue)

### 8.5 Success Metrics

The following metrics are tracked quarterly by the the maintainers and reported to the EAB:

| Metric | Target | What It Measures |
|---|---|---|
| Privacy rights request fulfillment rate | 100% within 30 days | Responsiveness to user rights exercises |
| Deletion execution accuracy | 100% — no deleted data persists | Data sovereignty in practice |
| Consent event audit pass rate | 100% — no prohibited consent patterns | Consent framework integrity |
| Unauthorized data access incidents | 0 | Internal access control compliance |
| Third-party data sharing events | Audit trail complete for 100% | External sharing accountability |
| Encryption coverage | 100% of user data at rest and in transit | Technical standard compliance |
| User-reported privacy concerns | Tracked; root cause analyzed for any repeat pattern | User trust signal |
| Time to complete account deletion | ≤ 30 days from cool-down expiry | Deletion rights execution |

A quarterly audit report covering all metrics is prepared by the the maintainers, reviewed by the EAB, and retained for a minimum of 3 years.

---

## 9. Compliance and Enforcement

### 9.1 All-Team Obligation

Every person or system that designs, builds, configures, or operates any aspect of this memory that touches user data is obligated to comply with this policy. This includes external contractors, integration partners, and cloud infrastructure providers.

### 9.2 Vendor and Partner Requirements

Any vendor, partner, or infrastructure provider that handles this memory user data must:

1. Sign a data processing agreement that is consistent with this policy
2. Accept audit rights for this memory (or its designated auditor)
3. Notify this memory within 24 hours of any security event that may affect user data
4. Delete user data within 30 days of this memory's request

Vendors that cannot meet these requirements may not handle user data.

### 9.3 Violation Reporting

Users may report suspected policy violations to the maintainers (open an issue). Reports are reviewed by the the maintainers within 5 business days.

### 9.4 Consequences of Non-Compliance

Internal violations are handled through standard HR and engineering accountability processes. Systemic or repeated violations may result in:

- Suspension of the offending feature or data practice
- Public disclosure via EAB findings
- Regulatory notification where legally required (including GDPR, CCPA, COPPA, and applicable data protection statutes)

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Affirmative consent** | An active, informed, voluntary agreement — not inferred from inaction or pre-checked |
| **Behavioral advertising** | Targeting advertising based on observed behavior, inferred interests, or personal data profiles |
| **Consent event** | A documented user decision to allow a specific data use, logged with date, scope, and plain-language description |
| **Data brokering** | Selling or licensing user data to third parties for their independent commercial use |
| **Default private** | A system design principle where data is not shared, collected, or used beyond core function unless the user explicitly enables it |
| **End-to-end encryption** | Encryption where only the intended parties (the user) hold decryption keys; the service provider cannot access plaintext |
| **Intentional forgetting** | The right and capability to permanently delete any memory, conversation, or data, with immediate and irreversible effect |
| **Key escrow** | A prohibited practice in which this memory would hold copies of user encryption keys — this memory does not do this |
| **User sovereignty** | The principle that the user is the ultimate authority over all data generated by or about them within this memory |

---

## Appendix B: Related Policies

- `GOV-TECH-001` — [Technical Governance & Schema Evolution Policy](technical-governance-schema-evolution-policy.md)
- `GOV-DAT-001` — [Data Governance & Memory Stewardship Policy](data-governance-memory-stewardship-policy.md)
- `GOV-ETH-001` — [Ethical AI Behavior Governance Policy](ethical-ai-behavior-policy.md)
- `GOV-LIF-001` — [Lifecycle & Age-Appropriate Governance Policy](lifecycle-age-appropriate-policy.md)

---

*This is a living document. Revisions are tracked in `docs/governance/CHANGELOG.md`.*
