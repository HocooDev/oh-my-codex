import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectReadyReport, readyCommand, type ReadyDependencies } from '../ready.js';

function commandRunner(
  handler: (command: string, args: string[]) => { status?: number; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException },
): NonNullable<ReadyDependencies['commandRunner']> {
  return (command, args) => {
    const result = handler(command, args);
    return {
      status: result.status ?? (result.error ? null : 0),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  };
}

describe('omx ready', () => {
  it('reports install, auth, exec, windows, and team readiness in JSON', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-ready-json-'));
    try {
      const lines: string[] = [];
      await readyCommand(['--json'], {
        cwd: wd,
        platform: 'linux',
        env: { PATH: '/bin' },
        tmuxResolver: () => '/usr/bin/tmux',
        writeOut: (line) => lines.push(line),
        commandRunner: commandRunner((_command, args) => {
          const joined = args.join(' ');
          if (joined.includes('doctor')) return { stdout: 'doctor ok\n' };
          if (args[0] === '--version') return { stdout: 'codex 1.2.3\n' };
          if (joined === 'login status') return { stdout: 'Logged in\n' };
          if (joined.includes('exec')) return { stdout: 'OMX-EXEC-OK\n' };
          return { status: 1, stderr: `unexpected ${joined}` };
        }),
      });

      const payload = JSON.parse(lines.join('\n')) as Awaited<ReturnType<typeof collectReadyReport>>;
      assert.equal(payload.command, 'omx ready');
      assert.equal(payload.ok, true);
      assert.equal(payload.skipped_exec, false);
      assert.deepEqual(
        payload.checks.map((check) => check.name),
        ['install', 'auth', 'exec', 'windows-runtime', 'team-runtime'],
      );
      assert.equal(payload.checks.find((check) => check.name === 'exec')?.status, 'pass');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports --skip-exec without running the smoke command', async () => {
    const seen: string[] = [];
    const report = await collectReadyReport(
      { skipExec: true },
      {
        cwd: '/repo',
        platform: 'linux',
        env: {},
        tmuxResolver: () => null,
        commandRunner: commandRunner((_command, args) => {
          seen.push(args.join(' '));
          if (args.join(' ').includes('doctor')) return {};
          if (args[0] === '--version') return { stdout: 'codex test\n' };
          if (args.join(' ') === 'login status') return { stdout: 'Logged in\n' };
          return { status: 1, stderr: 'unexpected' };
        }),
      },
    );

    assert.equal(report.ok, true);
    assert.equal(report.skipped_exec, true);
    assert.equal(report.checks.find((check) => check.name === 'exec')?.status, 'skip');
    assert.equal(seen.some((args) => args.includes(' exec ')), false);
  });

  it('fails auth when the Codex CLI is missing', async () => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    const report = await collectReadyReport(
      { skipExec: true },
      {
        cwd: '/repo',
        platform: 'linux',
        env: {},
        tmuxResolver: () => '/usr/bin/tmux',
        commandRunner: commandRunner((_command, args) => {
          if (args.join(' ').includes('doctor')) return {};
          if (args[0] === '--version') return { error: missing };
          return { status: 1, stderr: 'unexpected' };
        }),
      },
    );

    assert.equal(report.ok, false);
    const auth = report.checks.find((check) => check.name === 'auth');
    assert.equal(auth?.status, 'fail');
    assert.match(auth?.message ?? '', /Codex CLI is not ready/);
    assert.match(auth?.message ?? '', /ENOENT/);
  });

  it('fails exec when the real smoke call does not return the expected token', async () => {
    const report = await collectReadyReport(
      {},
      {
        cwd: '/repo',
        platform: 'linux',
        env: {},
        tmuxResolver: () => '/usr/bin/tmux',
        commandRunner: commandRunner((_command, args) => {
          const joined = args.join(' ');
          if (joined.includes('doctor')) return {};
          if (args[0] === '--version') return { stdout: 'codex test\n' };
          if (joined === 'login status') return { stdout: 'Logged in\n' };
          if (joined.includes('exec')) return { stdout: 'different response\n' };
          return { status: 1, stderr: 'unexpected' };
        }),
      },
    );

    const exec = report.checks.find((check) => check.name === 'exec');
    assert.equal(report.ok, false);
    assert.equal(exec?.status, 'fail');
    assert.match(exec?.message ?? '', /did not return OMX-EXEC-OK/);
  });

  it('surfaces PowerShell-specific Windows guidance for sparkshell, explore harness, psmux, and WSL2', async () => {
    const report = await collectReadyReport(
      { skipExec: true },
      {
        cwd: 'C:/repo',
        platform: 'win32',
        env: {
          OS: 'Windows_NT',
          PSModulePath: 'C:/Users/alice/Documents/WindowsPowerShell/Modules',
        },
        tmuxResolver: () => null,
        commandRunner: commandRunner((_command, args) => {
          if (args.join(' ').includes('doctor')) return {};
          if (args[0] === '--version') return { stdout: 'codex test\n' };
          if (args.join(' ') === 'login status') return { stdout: 'Logged in\n' };
          return { status: 1, stderr: 'unexpected' };
        }),
      },
    );

    const windows = report.checks.find((check) => check.name === 'windows-runtime');
    const team = report.checks.find((check) => check.name === 'team-runtime');
    assert.equal(windows?.status, 'warn');
    assert.match(windows?.message ?? '', /PowerShell/);
    assert.match(windows?.message ?? '', /omx sparkshell/);
    assert.match(windows?.message ?? '', /omx explore harness/);
    assert.equal(team?.status, 'warn');
    assert.match(team?.message ?? '', /psmux/);
    assert.match(team?.message ?? '', /WSL2/);
  });
});
