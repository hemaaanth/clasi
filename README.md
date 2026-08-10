# clasi

clasi, short for continuous learning and self-improvement, is an OMP-first Pi extension for durable coding guidance. It keeps three kinds of scoped, reviewable Markdown:

- Context: facts and explicit preferences that should affect future work.
- Napkins: short lessons that help a later agent avoid repeated work or mistakes.
- Papercuts: unresolved, fixable friction that can be reviewed, repaired, published, dismissed, and verified.

clasi injects a bounded active view before model requests. It does not scrape conversations, prompts, source files, or terminal output. Routine local commands do not need a model or provider credentials.

## Requirements

- [OMP](https://github.com/can1357/oh-my-pi) with `@oh-my-pi/pi-coding-agent` `>=17.2.4 <18`
- Bun
- A private, user-owned directory for clasi data

Git is needed when installing directly from a Git repository. GitHub CLI and Paseo are optional and only support explicit Papercut actions.

## Install the OMP plugin

The first release is installed directly from Git. It is not published to npm, so this README does not claim an npm or `bunx` installation path. Substitute the repository coordinates from the release location for `<owner>/<repo>`.

From a local checkout:

```bash
bun install --frozen-lockfile
omp plugin link /absolute/path/to/clasi
```

From Git:

```bash
omp plugin install github:hemaaanth/clasi
```

Restart OMP after linking, installing, upgrading, or uninstalling the plugin. Then check discovery:

```bash
omp plugin list
omp plugin doctor --json
```

In an interactive OMP session, run:

```text
/clasi
/skill:clasi
```

`/clasi` opens the interactive review and configuration surface. The bundled `clasi` skill tells the active agent when it is safe and useful to capture guidance.

See OMP's [extension loading documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md) for plugin scopes, links, and Git package installation.

## Install the separate CLI

OMP plugin installation does not put package executables on your global `PATH`. Install the same Git package separately when you want the `clasi` command outside OMP:

```bash
bun install --global github:<owner>/<repo>
```

Add the directory reported by `bun pm bin -g` to `PATH`, then verify the command:

```bash
clasi help
clasi version
```

You can also run the CLI from a checkout without a global install:

```bash
bun bin/clasi.ts help
```

The CLI is strict and provider-free. It accepts only documented commands and flags, writes one versioned JSON envelope, and never starts a model. Commands that can change durable state require explicit IDs and `--confirm`.

```bash
clasi status
clasi config
clasi doctor
clasi context --scope global
clasi napkin list global
clasi papercuts list global
clasi impact
```

A successful or partial result exits with status 0. A choice-required or setup-needed result exits with status 2. Degraded and error results exit with status 1.

## Setup

clasi separates machine-local control state from user data:

- The control root is `<OMP agent directory>/clasi`. OMP normally resolves the agent directory to `~/.omp/agent`; `PI_CODING_AGENT_DIR` can override it. The root contains local configuration, the machine ID, repository attachments, locks, and validated last-good views.
- The data root contains Context, Napkins, Papercuts, revisions, conflicts, and transaction state. `CLASI_HOME` selects this root. Without it, interactive setup uses `<OMP agent directory>/clasi/data`.

To use a shared or externally synchronized root, set `CLASI_HOME` before starting OMP, then run:

```text
/clasi setup
```

clasi detects safe machine facts such as WSL, OS, architecture, shell, and package managers automatically. Select **Use recommended defaults** to finish with no typing beyond the final confirmation.

Select **Customize 3 optional preferences** only when you want to add:

1. A global preference used in every repository, such as `Prefer concise explanations and minimal changes`.
2. A machine-specific preference, such as `Use WSL paths when commands cross into Windows`.
3. An absolute path to a Markdown instruction file. The import is staged for review rather than trusted automatically.

Each custom step offers a skip choice. The final screen shows exactly what will be stored; nothing is written until **Finish clasi setup** is confirmed.

For one-shot provider-free setup, pass an absolute root:

```bash
clasi setup --root /absolute/private/clasi-data --confirm
```

Read current values or prepare a cap change before confirming it:

```bash
clasi config
clasi config --napkin-category-cap 5
clasi config --napkin-category-cap 5 --confirm
clasi config --context-character-cap 6000 --confirm
```

The Napkin category cap accepts 1 through 20. The active context character cap accepts 500 through 6000.

## Scopes

clasi resolves guidance in this order: repository, machine, then global. A more specific record shadows the same logical key at a broader scope without deleting it.

- `global` is shared across all configured machines using the data root.
- `machine:machine_<id>` is tied to the random machine ID kept in local control state.
- `repository:repo_<id>` is derived from normalized Git remote coordinates. Linked worktrees from one clone share an attachment. Fork coordinates remain separate.

Run `clasi status` to obtain the active opaque machine and repository IDs. Commands that take a `--scope` value accept `global`, `machine:machine_<32 lowercase hex characters>`, or `repository:repo_<32 lowercase hex characters>`. `napkin list`, `napkin history`, and `papercuts list` accept the same scope as their optional final argument.

clasi does not synchronize the data root. You choose, configure, monitor, and recover the external sync transport. Cross-machine sync is eventually consistent; clasi does not claim a distributed lock or transaction across machines.

## Shared-root trust boundary

Use a private root owned by your operating-system account and a sync account you trust. clasi checks containment, ownership, permissions, file type, and root identity before I/O. It fails closed when these checks drift.

The shared root is trusted for integrity. clasi does not sign revisions or authenticate another writer in that root. A hostile or compromised sync writer is outside the first-release security boundary. Keep the root out of a repository and do not share it with untrusted users or services.

## Privacy and quarantine boundaries

clasi-authored state accepts bounded, typed, generalized fields. It rejects raw prompts, user or assistant messages, terminal output, source excerpts, environment dumps, paths, secrets, PII, customer data, and unclassified evidence. Source classification, pattern scans, named-entity reduction, and strict schemas provide defense in depth.

Those controls cannot prove that arbitrary generalized prose is semantically non-sensitive. You and the active agent remain responsible for not submitting sensitive meaning in otherwise ordinary text. Treat semantic screening as best effort, not as a data-loss-prevention guarantee.

During lossless replacement, clasi can move a pre-existing or concurrently written external file inode into `.clasi/quarantine`. Those displaced bytes remain owned by you or your sync transport. They are not clasi-authored evidence. clasi keeps unsafe or changing quarantine bytes opaque and does not parse, inject, copy, publish, or use them as evidence. Because the original external file can contain sensitive data, protect quarantine with the same controls as the rest of the shared root.

## Recovery and quiescence

Start with diagnostics:

```bash
clasi status
clasi doctor
clasi locks
clasi transactions list
clasi conflicts list
```

The interactive `/clasi` menu puts available recovery actions first. Missing setup or a degraded document does not block ordinary coding, but clasi disables affected reads or writes until recovery is safe.

Recover a lock only after the owner process is gone and diagnostics identify the document:

```bash
clasi recover-lock --document-id doc_<32 lowercase hex characters> --confirm
```

Conflicts preserve both observed versions and the last uncontested active view. clasi never chooses a branch or performs a semantic merge automatically. Inspect and revalidate a conflict before explicitly activating a revision.

Transaction cleanup is narrower than recovery. Before cleanup, stop OMP and other clasi writers, close editors that can write the data root, and pause its sync client. In other words, make the root quiescent. Then re-run diagnostics and, only for the reported transaction, use:

```bash
clasi clean-transaction --id tx_<32 lowercase hex characters> --confirm
```

Cleanup removes validated terminal transaction state and its quarantined displaced copy when present. It preserves canonical documents, revisions, and unrelated directories. If you cannot make every writer and sync client quiescent, leave the transaction and quarantine in place.

## Optional GitHub and Paseo actions

Local capture, review, context loading, the CLI, and impact reports do not require GitHub or Paseo.

Publishing a Papercut as a GitHub issue requires the `gh` CLI, an authenticated account with access to the current repository, and explicit confirmation of both the account and repository. GitHub publication is the only clasi-initiated remote disclosure.

Repair dispatch prefers Paseo when its CLI is installed, `~/.paseo/orchestration-preferences.json` names an implementation provider, and `paseo provider ls --json` reports that provider as available. It requests a new worktree and branch. When Paseo is unavailable, an interactive OMP session can use Pi follow-up dispatch if the host provides it. clasi does not schedule repairs automatically.

## Coexistence with OMP memory

clasi does not register or intercept `/memory`, change OMP memory settings, or write OMP's built-in memory files. The two systems have separate namespaces and can both be enabled. `clasi doctor` can report built-in memory status when the host exposes it, but it never disables that system. Review both sources if you see duplicate guidance.

## Uninstall

For a Git-installed plugin, remove it and restart OMP:

```bash
omp plugin uninstall clasi
```

For a development checkout added with `omp plugin link`, OMP 17.2.4 clears registry metadata but can leave the `~/.omp/plugins/node_modules/clasi` symlink. Verify that path is a symlink to your checkout, unlink the symlink itself without deleting its target, then restart OMP.

If you separately installed the global CLI, remove that package too:

```bash
bun remove --global clasi
```

Uninstalling package code preserves both the configured data root and `<PI_CODING_AGENT_DIR>/clasi`. This prevents package removal from deleting Context, Napkins, Papercuts, conflicts, or recovery state. To remove that data permanently, first stop every OMP and clasi process, pause external sync, keep any backup you need, and delete the two roots yourself.

## Support and release evidence

The declared Pi peer range is `>=17.2.4 <18`. Release checks cover exact OMP 17.2.4 and the latest available 17.x release.

No platform or model gate is claimed until its evidence file exists from the actual check. Current first-release status:

| Gate | Status |
| --- | --- |
| WSL platform | Passed on WSL x64 with OMP 17.2.4 and 17.2.12 through pinned public Git installs |
| macOS platform | Passed on macOS arm64 with OMP 17.2.4 and 17.2.12 through pinned public Git installs |
| Native Windows platform | Blocked: 438/438 native tests pass, but the isolated OMP smoke currently fails during setup before public Git installation or evidence emission |
| Release-model capture evaluation | Passed 10/10 with `openai-codex/gpt-5.4`; aggregate evidence generated |

Native Linux may work through Pi, but it is not a first-release platform gate. CI on Ubuntu does not count as WSL evidence. `release:validate` fails when required actual evidence or an OMP matrix row is missing. Generated evidence is a release artifact, not source, and CI does not commit it.
The model gate records only aggregate results. The requested and served model identities must match, and at least 8 of 10 capture decisions must be correct. Prompts, responses, and transcripts are not release evidence.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run smoke:host
bun run smoke:omp
bun run test:concurrency
bun run test:privacy
bun run model:eval
bun run release:validate
```

`smoke:host` exercises the deterministic fake host. `smoke:omp` always performs isolated local-link discovery, loopback model and skill loading, and provider-free global Git installation. Platform evidence additionally requires `CLASI_PUBLIC_GIT_SPEC=github:<owner>/<repo>#<full-commit-id>` so the OMP Git-install and uninstall path is real; CI supplies this from the checked-out repository and commit. `model:eval` requires `CLASI_MODEL_EVAL_COMMAND` and `CLASI_MODEL_EVAL_REQUESTED_MODEL`; `CLASI_MODEL_EVAL_ARGS_JSON` can provide a JSON string array of arguments. The adapter receives one bounded JSON request on standard input and must return the requested model, served model, and ten decisions. It writes evidence only after that evaluation executes. Set `CLASI_EVIDENCE_DIR` to override the default `release/evidence` directory.

## License

MIT. See [LICENSE](LICENSE).
