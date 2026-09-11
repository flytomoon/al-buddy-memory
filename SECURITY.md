# Security

The store is local-first: one SQLite file, no network, no service. The things that can
go wrong are in the data you put in it and the process that reads it.

- **Report a vulnerability** by email to chris@canfieldmagic.com with "al-buddy-memory"
  in the subject. Acknowledged within two days, fixed or mitigated within fourteen for
  anything that affects confidentiality of stored facts.
- **What is enforced:** Sealed facts never surface unless asked for by classification;
  provenance, id, key reference and the temporal-anchor trail are immutable after write;
  governance policies (docs/GOVERNANCE.md) can refuse writes, hide reads and gate exports,
  with an append-only audit trail.
- **What is not:** encryption at rest. `encryptionKeyRef` names the key you manage; the
  store does not encrypt the file. Put it on an encrypted volume.
- **Dependencies:** one runtime dependency (better-sqlite3). Advisories are checked weekly.
