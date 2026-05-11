# Brainstorm CLI Guide

`omx brainstorm` is the artifact-first design exploration bridge for OMX.

Use it when you want a reviewable markdown design report before you commit to
`$deep-interview`, `$ralplan`, `$team`, or `$ralph`.

## When to use `omx brainstorm`

Use `omx brainstorm` when you want:

- a canonical markdown artifact under `.omx/specs/`
- durable design exploration that can be resumed later
- optional external advisor input from local Claude/Gemini CLIs
- an explicit approval/handoff record without auto-starting the next workflow

## When to use `$brainstorm`

Use `$brainstorm` when you want the prompt/workflow surface inside an OMX
session.

Use `omx brainstorm` when you specifically want the CLI artifact/runtime
surface:

- write or revise the canonical brainstorm markdown
- resume by slug
- browse prior brainstorm artifacts
- inspect artifact/state metadata from shell or CI

## Command summary

```bash
omx brainstorm init [--idea <text>] [--slug <slug>] [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini] [--non-interactive]
omx brainstorm resume --slug <slug> [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini] [--non-interactive]
omx brainstorm approve --slug <slug> [--json]
omx brainstorm status [--slug <slug> | --latest] [--json]
omx brainstorm doctor [--json]
omx brainstorm list [--json]
omx brainstorm history --slug <slug> [--json]
```

### `init`

Creates a new brainstorm draft.

- interactive when run in a TTY
- non-interactive when `--idea` is provided
- write markdown + context snapshot + brainstorm state
- `--non-interactive` / `--quick` skips the guided TTY prompts and creates a seed draft directly (useful for CI and scripts)

### `resume`

Continues an existing brainstorm by slug.

- requires `--slug`
- always resumes from the latest brainstorm artifact for that slug
- always writes a **new timestamped latest artifact**
- does **not** overwrite the prior artifact revision
- if the previous artifact was approved, the new resumed artifact starts from
  `draft` again
- `--non-interactive` / `--quick` skips the guided TTY prompts (useful for CI and scripts)

### `approve`

Marks a draft brainstorm artifact as approved without entering the interactive
guided flow.

- requires `--slug`
- reads the existing artifact's idea, desired outcome, constraints, and advisor context
- writes a **new timestamped artifact** marked as `approved_for_ralplan`
- use `--json` for machine-readable output
- the approved artifact can be consumed by `$ralplan --from-design`

### `status`

Reads the latest matching artifact plus compatible state metadata.

Use it when you already know the slug and want the current handoff state.

Human-readable output now includes a `Next actions` block so the shell output
shows the current continue / handoff / stop options directly.

### `doctor`

Preflights the local Claude/Gemini advisor surfaces without writing a brainstorm
artifact.

Use it when you want to verify:

- whether `claude` is executable
- whether `gemini` is executable
- whether provider binary/script overrides are active
- what to fix before rerunning brainstorm with advisor flags

### `list`

Shows every brainstorm artifact, newest first.

Use it when you do **not** remember the slug and need discovery.

### `history`

Shows every artifact revision for a slug, newest first.

Use it when you want to compare how a brainstorm evolved over time.

## Typical workflows

### 1. Create a first draft

```bash
omx brainstorm init --idea "Review search UX direction" --slug search-ux --lang en
```

### 2. Create a draft with external advisors

```bash
omx brainstorm init \
  --idea "Review rollout strategy" \
  --slug rollout-strategy \
  --with-claude \
  --with-gemini
```

### 3. Resume a prior brainstorm

```bash
omx brainstorm resume --slug rollout-strategy
```

### 4. Discover prior brainstorms

```bash
omx brainstorm list
omx brainstorm history --slug rollout-strategy
```

### 5. Inspect machine-readable state

```bash
omx brainstorm status --slug rollout-strategy --json
omx brainstorm doctor --json
omx brainstorm list --json
omx brainstorm history --slug rollout-strategy --json
```

## Advisor flags

`--with-claude` and `--with-gemini` run the matching local provider CLI.

Behavior:

- advisor success is written into `.omx/artifacts/ask-<provider>-...`
- successful advisor input is folded into the core brainstorm sections
- advisor failure is recorded as metadata and warnings only
- advisor failure does **not** abort the main brainstorm artifact
- `omx brainstorm doctor` reports actionable CLI / override issues before you
  launch advisor-backed drafts

## Next actions and repo-aware output

Each canonical brainstorm markdown now includes:

- an explicit `Next Actions` block under the handoff section
- localized visible CTA copy in Chinese mode while preserving stable machine
  anchors for downstream parsing
- a repo-aware context scan that surfaces likely touched modules, related
  workflows, and current repo/runtime constraints from a live scan

## Artifact and state layout

The canonical surfaces are:

- brainstorm artifact: `.omx/specs/brainstorm-<timestamp>-<slug>.md`
- context snapshot: `.omx/context/<slug>-<timestamp>.md`
- brainstorm runtime state: `.omx/state/brainstorm-state.json`
- advisor artifacts: `.omx/artifacts/ask-<provider>-...`

The markdown artifact remains the canonical design record. There is no required
brainstorm JSON sidecar.

## Common errors and recovery

### `No brainstorm artifact found for slug "..."`

The slug has no canonical brainstorm artifact yet.

Recovery:

1. run `omx brainstorm list`
2. find the correct slug
3. rerun `omx brainstorm resume --slug <slug>`

### Missing provider CLI

If Claude or Gemini is unavailable, the brainstorm still completes, but the
advisor run is marked failed.

Recovery:

1. install/configure the provider CLI
2. verify it outside OMX
3. rerun `omx brainstorm resume --slug <slug> --with-claude` or
   `--with-gemini`

### Non-interactive shell without `--idea`

`init` needs `--idea` when there is no interactive terminal.

Recovery:

- provide `--idea`
- or rerun interactively

## Why brainstorm does not auto-start downstream workflows

`omx brainstorm` records decisions; it does not execute them.

That boundary is intentional:

- design exploration can stay reviewable
- humans can inspect the artifact before handoff
- approvals remain explicit
- downstream workflows do not inherit an accidental draft

## Moving from brainstorm into `deep-interview` or `ralplan`

If the brainstorm artifact is approved for requirements clarification:

```text
$deep-interview "Clarify the approved brainstorm direction from .omx/specs/brainstorm-....md: ..."
```

If the brainstorm artifact is approved for planning:

```text
$ralplan --from-design .omx/specs/brainstorm-....md "Turn the approved brainstorm direction into a PRD and test spec"
```

You can also inspect the recommended next step directly from:

- `omx brainstorm status --slug <slug>`
- the `## 15. Ralplan Handoff` section inside the artifact
- the `artifact:` contract block inside the markdown
