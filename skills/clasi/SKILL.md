---
name: clasi
description: Use clasi to retain safe durable context, reusable repository guidance, and actionable papercuts without storing prompts, terminal output, source excerpts, secrets, PII, or customer data.
---

# clasi

clasi provides three distinct kinds of quiet, scoped memory:

- **Context**: a stable fact or explicit preference that should affect future work. Repository Context overrides machine Context, which overrides global-user Context for the same logical key.
- **Napkin**: a short, reusable working lesson. Use one of Execution, Validation, Tooling, Repository Conventions, or Domain Guardrails. Record a hit when remembered guidance materially helps.
- **Papercut**: unresolved, fixable friction with a reproducible generalized cause. Capture it without interrupting the current task; recurrence strengthens the same open item only when its canonical fingerprint matches exactly.

## Safety gate

Never send clasi raw prompts, user or assistant messages, terminal output, source excerpts, environment dumps, paths, secrets, PII, customer data, or unclassified evidence. Do not summarize excluded source into a named person, organization, credential, path, or quoted fragment. Use only generalized derived fields, canonical keys, safe counters, and an explicit source classification accepted by the tool schema.

If safe classification is uncertain, do not call a mutation tool. Continue the user's task and leave no clasi-authored derivative. Use `/clasi review` later for proposals, history, papercuts, and conflicts.

## Capture judgment

1. Prefer **Context** when the statement remains true independent of one incident.
2. Prefer a **Napkin** when a future agent can take a concrete action that avoids repeated work or error.
3. Prefer a **Papercut** when the underlying product or workflow should be repaired rather than remembered indefinitely.
4. Ignore trivia, one-off outcomes, speculative advice, duplicate wording, and anything already enforced by code or configuration.
5. Keep entries specific enough to act on and no longer than 240 characters.

Routine capture and loading are silent. Surface only blocked setup, unsafe retention, corruption, or a write conflict that risks data loss.
