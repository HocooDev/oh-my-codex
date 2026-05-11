import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  diagnoseProviderAdvisor,
  executeProviderAdvisor,
} from '../provider-advisor.js';

async function initWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'omx-provider-advisor-test-'));
}

async function createFakeProviderScript(root: string, name: 'claude' | 'gemini'): Promise<string> {
  const scriptPath = join(root, `${name}-stub.js`);
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") {',
      `  console.log("${name}-stub 1.0.0");`,
      '  process.exit(0);',
      '}',
      'const promptIndex = args.indexOf("-p");',
      'if (promptIndex >= 0) {',
      `  console.log("${name.toUpperCase()}_OK:" + (args[promptIndex + 1] ?? ""));`,
      '  process.exit(0);',
      '}',
      'console.error("unexpected args");',
      'process.exit(3);',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(scriptPath, 0o755).catch(() => {});
  return scriptPath;
}

describe('provider advisor execution', () => {
  it('writes ask-<provider>- artifacts for successful provider runs', async () => {
    const repo = await initWorkspace();
    try {
      const scriptPath = await createFakeProviderScript(repo, 'claude');
      const result = await executeProviderAdvisor({
        provider: 'claude',
        prompt: 'review this direction',
        originalTask: 'Review this direction',
        cwd: repo,
        env: {
          ...process.env,
          OMX_ASK_PROVIDER_CLAUDE_SCRIPT: scriptPath,
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.match(result.artifactPath, /ask-claude-review-this-direction-/i);
      assert.equal(existsSync(result.artifactPath), true);
      const artifact = await readFile(result.artifactPath, 'utf8');
      assert.match(artifact, /CLAUDE_OK:review this direction/);
      assert.match(artifact, /Status: succeeded/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records missing provider binaries as failed artifacts without throwing', async () => {
    const repo = await initWorkspace();
    try {
      const result = await executeProviderAdvisor({
        provider: 'gemini',
        prompt: 'brainstorm this direction',
        originalTask: 'Brainstorm this direction',
        cwd: repo,
        env: {
          ...process.env,
          OMX_ASK_PROVIDER_GEMINI_BIN: 'definitely-missing-gemini-binary',
        },
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.match(result.artifactPath, /ask-gemini-brainstorm-this-direction-/i);
      assert.equal(existsSync(result.artifactPath), true);
      const artifact = await readFile(result.artifactPath, 'utf8');
      assert.match(artifact, /Missing required local CLI binary/i);
      assert.match(artifact, /Status: failed/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports binary and script override readiness in doctor mode', async () => {
    const repo = await initWorkspace();
    try {
      const scriptPath = await createFakeProviderScript(repo, 'claude');
      const result = await diagnoseProviderAdvisor({
        provider: 'claude',
        cwd: repo,
        env: {
          ...process.env,
          OMX_ASK_PROVIDER_CLAUDE_BIN: process.execPath,
          OMX_ASK_PROVIDER_CLAUDE_SCRIPT: scriptPath,
        },
      });

      assert.equal(result.ready, true);
      assert.equal(result.binary.ready, true);
      assert.equal(result.binary.configured, process.execPath);
      assert.equal(result.script.overridden, true);
      assert.equal(result.script.ready, true);
      assert.equal(result.script.configured, scriptPath);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
