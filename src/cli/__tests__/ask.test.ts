import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAskArgs } from '../ask.js';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function runProviderAdvisorScript(
  cwd: string,
  argv: string[],
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const scriptPath = join(repoRoot, 'dist', 'scripts', 'run-provider-advisor.js');
  const r = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}


function normalizeDarwinTmpPath(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function createProviderScript(
  root: string,
  provider: 'claude' | 'gemini',
  body: string[],
): Promise<string> {
  const scriptPath = join(root, `${provider}-provider-script.js`);
  await writeFile(scriptPath, body.join('\n'), 'utf8');
  return scriptPath;
}

describe('parseAskArgs', () => {
  it('parses positional prompt form', () => {
    assert.deepEqual(parseAskArgs(['claude', 'review', 'this']), {
      provider: 'claude',
      prompt: 'review this',
    });
  });

  it('parses -p prompt form', () => {
    assert.deepEqual(parseAskArgs(['gemini', '-p', 'brainstorm', 'ideas']), {
      provider: 'gemini',
      prompt: 'brainstorm ideas',
    });
  });

  it('parses --print prompt form', () => {
    assert.deepEqual(parseAskArgs(['claude', '--print', 'review', 'this']), {
      provider: 'claude',
      prompt: 'review this',
    });
  });

  it('parses --prompt prompt form', () => {
    assert.deepEqual(parseAskArgs(['gemini', '--prompt', 'brainstorm', 'ideas']), {
      provider: 'gemini',
      prompt: 'brainstorm ideas',
    });
  });

  it('parses --agent-prompt with positional task text', () => {
    assert.deepEqual(parseAskArgs(['claude', '--agent-prompt', 'executor', 'review', 'this']), {
      provider: 'claude',
      prompt: 'review this',
      agentPromptRole: 'executor',
    });
  });

  it('parses --agent-prompt=<role> with --prompt task text', () => {
    assert.deepEqual(parseAskArgs(['gemini', '--agent-prompt=planner', '--prompt', 'brainstorm', 'ideas']), {
      provider: 'gemini',
      prompt: 'brainstorm ideas',
      agentPromptRole: 'planner',
    });
  });

  it('throws for invalid provider', () => {
    assert.throws(() => parseAskArgs(['openai', 'hello']), /Invalid provider/);
  });

  it('throws when prompt is missing', () => {
    assert.throws(() => parseAskArgs(['claude']), /Missing prompt text/);
  });

  it('throws when --agent-prompt role is missing', () => {
    assert.throws(() => parseAskArgs(['claude', '--agent-prompt', '--prompt', 'hello']), /Missing role after --agent-prompt/);
  });
});

describe('omx ask', () => {
  it('script usage documents provider-specific long flags from CLI help', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-usage-'));
    try {
      const res = runProviderAdvisorScript(wd, []);
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /claude --print/);
      assert.match(res.stderr, /gemini --prompt/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves child stdout/stderr and exact non-zero exit code', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-contract-'));
    try {
      const res = runOmx(wd, ['ask', 'claude', 'pass-through'], {
        OMX_ASK_ADVISOR_SCRIPT: 'dist/scripts/fixtures/ask-advisor-stub.js',
        OMX_ASK_STUB_STDOUT: 'artifact-path-from-stub.md\n',
        OMX_ASK_STUB_STDERR: 'stub-warning-line\n',
        OMX_ASK_STUB_EXIT_CODE: '7',
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 7, res.stderr || res.stdout);
      assert.equal(res.stdout, 'artifact-path-from-stub.md\n');
      assert.equal(res.stderr, 'stub-warning-line\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('resolves relative advisor override path from package root even on non-root cwd', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-relative-'));
    try {
      const res = runOmx(wd, ['ask', 'gemini', 'relative-check'], {
        OMX_ASK_ADVISOR_SCRIPT: 'dist/scripts/fixtures/ask-advisor-stub.js',
        OMX_ASK_STUB_STDOUT: 'relative-override-ok\n',
        OMX_ASK_STUB_EXIT_CODE: '0',
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(res.stdout, 'relative-override-ok\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('uses package-root advisor script path from non-package cwd and still writes artifact', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-nonroot-'));
    try {
      const scriptPath = await createProviderScript(wd, 'claude', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === "-p") { console.log("NONROOT_DEFAULT_OK"); process.exit(0); }',
        'console.error("unexpected", JSON.stringify(args));',
        'process.exit(3);',
      ]);

      const res = runOmx(wd, ['ask', 'claude', 'non-root-default'], {
        OMX_ASK_PROVIDER_CLAUDE_SCRIPT: scriptPath,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      const artifactPath = res.stdout.trim();
      assert.ok(normalizeDarwinTmpPath(artifactPath).startsWith(normalizeDarwinTmpPath(join(wd, '.omx', 'artifacts', 'ask-claude-'))));
      assert.equal(existsSync(artifactPath), true);
      const artifact = await readFile(artifactPath, 'utf-8');
      assert.match(artifact, /NONROOT_DEFAULT_OK/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports claude --print and gemini --prompt end-to-end through omx ask', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-provider-flags-'));
    try {
      const claudeScript = await createProviderScript(wd, 'claude', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const promptIndex = args.indexOf("-p");',
        'if (promptIndex >= 0) { console.log(`CLAUDE_PRINT_OK:${args[promptIndex + 1] ?? ""}`); process.exit(0); }',
        'console.error("unexpected", JSON.stringify(args));',
        'process.exit(3);',
      ]);
      const geminiScript = await createProviderScript(wd, 'gemini', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const promptIndex = args.indexOf("-p");',
        'if (promptIndex >= 0) { console.log(`GEMINI_PROMPT_OK:${args[promptIndex + 1] ?? ""}`); process.exit(0); }',
        'console.error("unexpected", JSON.stringify(args));',
        'process.exit(4);',
      ]);
      const env = {
        OMX_ASK_PROVIDER_CLAUDE_SCRIPT: claudeScript,
        OMX_ASK_PROVIDER_GEMINI_SCRIPT: geminiScript,
      };

      const claudeRes = runOmx(wd, ['ask', 'claude', '--print', 'claude-long-flag'], env);
      if (shouldSkipForSpawnPermissions(claudeRes.error)) return;
      assert.equal(claudeRes.status, 0, claudeRes.stderr || claudeRes.stdout);
      const claudeArtifactPath = claudeRes.stdout.trim();
      const claudeArtifact = await readFile(claudeArtifactPath, 'utf-8');
      assert.match(claudeArtifact, /CLAUDE_PRINT_OK:claude-long-flag/);

      const geminiRes = runOmx(wd, ['ask', 'gemini', '--prompt', 'gemini-long-flag'], env);
      assert.equal(geminiRes.status, 0, geminiRes.stderr || geminiRes.stdout);
      const geminiArtifactPath = geminiRes.stdout.trim();
      const geminiArtifact = await readFile(geminiArtifactPath, 'utf-8');
      assert.match(geminiArtifact, /GEMINI_PROMPT_OK:gemini-long-flag/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('adds Claude skip-permissions for issue-work prompts only', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-issue-permissions-'));
    try {
      const claudeScript = await createProviderScript(wd, 'claude', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'console.log(`CLAUDE_ARGS:${args.join(" ")}`);',
      ]);
      const env = { OMX_ASK_PROVIDER_CLAUDE_SCRIPT: claudeScript };

      const issueRes = runOmx(wd, ['ask', 'claude', 'Investigate issue #1536 and summarize it'], env);
      if (shouldSkipForSpawnPermissions(issueRes.error)) return;
      assert.equal(issueRes.status, 0, issueRes.stderr || issueRes.stdout);
      const issueArtifactPath = issueRes.stdout.trim();
      const issueArtifact = await readFile(issueArtifactPath, 'utf-8');
      assert.match(issueArtifact, /CLAUDE_ARGS:--dangerously-skip-permissions -p Investigate issue #1536 and summarize it/);

      const genericRes = runOmx(wd, ['ask', 'claude', 'Summarize the README'], env);
      assert.equal(genericRes.status, 0, genericRes.stderr || genericRes.stdout);
      const genericArtifactPath = genericRes.stdout.trim();
      const genericArtifact = await readFile(genericArtifactPath, 'utf-8');
      assert.match(genericArtifact, /CLAUDE_ARGS:-p Summarize the README/);
      assert.doesNotMatch(genericArtifact, /--dangerously-skip-permissions/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('injects --agent-prompt content into final prompt while keeping Original task raw', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-agent-prompt-'));
    try {
      const codexHome = join(wd, '.codex-home');
      const promptsDir = join(codexHome, 'prompts');
      await mkdir(promptsDir, { recursive: true });

      await writeFile(
        join(promptsDir, 'executor.md'),
        'You are Executor.\nFollow strict verification rules.',
      );

      const claudeScript = await createProviderScript(wd, 'claude', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const promptIndex = args.indexOf("-p");',
        'if (promptIndex >= 0) { console.log(`CLAUDE_FINAL_PROMPT:${args[promptIndex + 1] ?? ""}`); process.exit(0); }',
        'console.error("unexpected", JSON.stringify(args));',
        'process.exit(3);',
      ]);

      const res = runOmx(
        wd,
        ['ask', 'claude', '--agent-prompt', 'executor', 'ship', 'feature'],
        { OMX_ASK_PROVIDER_CLAUDE_SCRIPT: claudeScript, CODEX_HOME: codexHome },
      );
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 0, res.stderr || res.stdout);
      const artifactPath = res.stdout.trim();
      const artifact = await readFile(artifactPath, 'utf-8');
      assert.match(artifact, /## Original task\n\nship feature/);
      assert.match(artifact, /## Final prompt[\s\S]*You are Executor\./);
      assert.match(artifact, /## Final prompt[\s\S]*Follow strict verification rules\./);
      assert.match(artifact, /## Final prompt[\s\S]*ship feature/);
      assert.match(artifact, /CLAUDE_FINAL_PROMPT:/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails clearly when --agent-prompt role is missing from prompts directory', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ask-agent-prompt-missing-'));
    try {
      const codexHome = join(wd, '.codex-home');
      const promptsDir = join(codexHome, 'prompts');
      await mkdir(promptsDir, { recursive: true });
      const geminiScript = await createProviderScript(wd, 'gemini', [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const promptIndex = args.indexOf("-p");',
        'if (promptIndex >= 0) { console.log("should-not-run"); process.exit(0); }',
        'console.error("unexpected", JSON.stringify(args));',
        'process.exit(4);',
      ]);

      const res = runOmx(
        wd,
        ['ask', 'gemini', '--agent-prompt=planner', '--prompt', 'do', 'planning'],
        { OMX_ASK_PROVIDER_GEMINI_SCRIPT: geminiScript, CODEX_HOME: codexHome },
      );
      if (shouldSkipForSpawnPermissions(res.error)) return;

      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stderr, /--agent-prompt role "planner" not found/i);
      assert.doesNotMatch(res.stdout, /should-not-run/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
