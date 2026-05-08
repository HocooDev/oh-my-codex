# Windows custom `omx explore` harness

This document describes the Windows-native `omx explore` path and the packaged release behavior.

## Status

- Packaged Windows installs now auto-wire a Windows-compatible custom harness for `omx explore`.
- The legacy Rust `omx-explore-harness.exe` remains unsupported on native Windows and is excluded from the native release manifest.
- `OMX_EXPLORE_BIN` still works as an explicit override when you want to point `omx explore` at a different Windows harness.
- `omx sparkshell` remains the primary shell helper for noisy read-only shell commands and broader shell-native lookups.

## Packaged release behavior

On packaged Windows installs, `omx explore` now resolves the PowerShell wrapper automatically. No environment override is required.

## Recommended override entrypoint

```powershell
$env:OMX_EXPLORE_BIN = "src/scripts/explore-windows-harness.ps1"
```

Then run:

```powershell
node dist/cli/omx.js explore --prompt "find auth"
```

## Why `.ps1` is recommended

`omx explore` passes a fully composed prompt to the harness, and that prompt can contain embedded newlines because wiki context and prompt-contract context are injected before the user request is sent onward.

The PowerShell wrapper preserves those multiline arguments more reliably than a `.cmd` wrapper when launched through the current Windows command-path handling, so it is also the packaged default.

## Optional probe mode

The wrapper supports lightweight diagnostics:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File src/scripts/explore-windows-harness.ps1 --probe entrypoint
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File src/scripts/explore-windows-harness.ps1 --probe codex-launch
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File src/scripts/explore-windows-harness.ps1 --probe tooling
```

Use `--probe-output <path>` to save probe output as JSON.

## Current contract

The Windows harness preserves these behavior layers:

1. Launcher contract
   - accepts `--cwd`, `--prompt`, `--prompt-file`, `--instructions-file`, `--model-spark`, `--model-fallback`
2. Prompt/runtime contract
   - keeps the read-only repository exploration role
   - uses a Windows-specific preamble instead of the current POSIX/bash-oriented wrapper guidance
3. Codex-launch contract
   - still uses `codex exec`
   - preserves read-only mode, low reasoning, repo cwd binding, and output-file capture
4. Output/fallback contract
   - markdown-only stdout on success
   - preserves stderr fallback metadata and stdout `## OMX Explore fallback`
5. Safety contract
   - repo-bounded allowlist validation
   - fail-closed direct-command and shell-proxy validation
   - no silent broadening to richer tools

## Notes

- The Windows harness currently prefers the direct allowlist lane and keeps shell proxying as a secondary fallback.
- `rg` still depends on a host `rg` binary. When unavailable, the harness fails with actionable stderr instead of silently broadening behavior.
- The `.cmd` wrapper remains available for narrow/manual use, but `.ps1` is the recommended packaged and override entrypoint for regular Windows usage.
