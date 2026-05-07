# HocooDev oh-my-codex Fork

**Language:** English | [简体中文](./README.fork.zh-CN.md)

This fork keeps the original `oh-my-codex` shape, but adjusts several details that affect daily use: how the assistant receives instructions, how long tasks are handled, how setup is checked, and how the session ends.

It is still meant to be used as `oh-my-codex`, with the `omx` command.

## What this fork changes

### 1. Role instructions are packaged more cleanly

The original project keeps many role instructions as prompt files. This fork moves those instructions into installable skill files.

In practice, that means role behavior is easier to install, refresh, and check. It also reduces the chance that an old prompt file keeps affecting the assistant after setup has changed.

### 2. Larger tasks can move with fewer pauses

For larger requests, the assistant now has clearer rules for when it should continue, when it should review, and when it should stop to ask for input.

The goal is not to make the assistant “more automatic” at any cost. The goal is to keep safe, reversible work moving while still stopping for decisions that really need the user.

### 3. Every task ends with a short finish check

This fork makes the final check part of the normal task flow.

At the end of a task, the assistant should report:

- what was done;
- whether project notes need an update;
- whether project instructions need an update;
- whether any reusable skill or rule should be changed.

The report follows the language of the conversation. Chinese users get the Chinese format, English users get the English format, and other languages can be used as well.

### 4. Setup refreshes are stricter

`omx setup` and related checks are more careful about old generated files.

This helps avoid a common class of problems: setup appears to succeed, but an older local file still changes how the assistant behaves. The fork prefers a cleaner refresh, clearer warnings, and stronger checks before claiming the installation is healthy.

### 5. `omx ready` gives a quick preflight check

This fork adds:

```bash
omx ready
```

Use it before relying on a new or refreshed setup. It checks the local environment, the Codex connection, and the basic ability to run a small command.

This is especially useful on Windows or in terminals where login state, shell behavior, or command visibility can differ from the normal path.

### 6. Interactive questions fail safely

Some tasks need a visible prompt so the user can answer a question. In a background session or a non-interactive terminal, that prompt may not be visible.

This fork avoids waiting forever in that case. If a visible prompt cannot be confirmed, the question path stops early instead of silently hanging.

### 7. Reminders are easier to maintain

The reminder and notification behavior has been separated more clearly from the rest of the command flow.

For users, the result should be simple: fewer hidden failures, steadier reminders, and behavior that is easier to test when something goes wrong.

## What remains the same

- The main command is still `omx`.
- The package name remains `oh-my-codex`.
- The project is still a companion layer for OpenAI Codex CLI.
- The upstream documentation links and MIT license are unchanged.

## Build and check locally

From the repository root:

```bash
npm install
npm run build
npm run verify:native-agents
```

This fork has not been published as a separate npm package unless stated elsewhere.
