import { resolveTmuxBinaryForPlatform, spawnPlatformCommandSync } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export type ReadyStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ReadyCheck {
  name: 'install' | 'auth' | 'exec' | 'windows-runtime' | 'team-runtime';
  status: ReadyStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReadyReport {
  command: 'omx ready';
  ok: boolean;
  cwd: string;
  skipped_exec: boolean;
  checks: ReadyCheck[];
}

interface ReadyCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

interface ReadyCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type ReadyCommandRunner = (
  command: string,
  args: string[],
  options: ReadyCommandOptions,
) => ReadyCommandResult;

export interface ReadyOptions {
  json?: boolean;
  skipExec?: boolean;
}

export interface ReadyDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandRunner?: ReadyCommandRunner;
  tmuxResolver?: (
    platform?: NodeJS.Platform,
    env?: NodeJS.ProcessEnv,
  ) => string | null;
  writeOut?: (line: string) => void;
}

const EXEC_SMOKE_PROMPT = 'Reply with exactly OMX-EXEC-OK';
const EXEC_SMOKE_TOKEN = 'OMX-EXEC-OK';

function defaultCommandRunner(
  command: string,
  args: string[],
  options: ReadyCommandOptions,
): ReadyCommandResult {
  const { result } = spawnPlatformCommandSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

function resolveSelfInvocation(): { command: string; argsPrefix: string[] } {
  const entryPath = resolveOmxCliEntryPath();
  if (entryPath) {
    return { command: process.execPath, argsPrefix: [entryPath] };
  }
  return { command: 'omx', argsPrefix: [] };
}

function summarizeFailure(result: ReadyCommandResult, fallback: string): string {
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : '';
    return `${fallback}${code}: ${result.error.message}`;
  }
  const detail = (result.stderr || result.stdout || '').trim();
  if (detail) return detail.split(/\r?\n/)[0] ?? fallback;
  return result.status === null ? fallback : `${fallback} (exit ${result.status})`;
}

function isNativeWindowsRuntime(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  return platform === 'win32' || env.OS === 'Windows_NT';
}

function isPowerShellLike(env: NodeJS.ProcessEnv): boolean {
  const shell = `${env.SHELL || ''} ${env.ComSpec || ''} ${env.PSModulePath || ''} ${env.TERM_PROGRAM || ''}`;
  return /powershell|pwsh|WindowsPowerShell/i.test(shell);
}

function makeSelfCommandArgs(args: string[]): { command: string; args: string[] } {
  const self = resolveSelfInvocation();
  return { command: self.command, args: [...self.argsPrefix, ...args] };
}

function runInstallCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: ReadyCommandRunner,
): ReadyCheck {
  const command = makeSelfCommandArgs(['doctor']);
  const result = run(command.command, command.args, { cwd, env });
  if (result.error || result.status !== 0) {
    return {
      name: 'install',
      status: 'fail',
      message: `omx doctor failed: ${summarizeFailure(result, 'doctor could not run')}`,
      details: { exit_code: result.status },
    };
  }
  return {
    name: 'install',
    status: 'pass',
    message: 'omx doctor completed; local install diagnostics are reachable',
  };
}

function runAuthCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: ReadyCommandRunner,
): ReadyCheck {
  const version = run('codex', ['--version'], { cwd, env });
  if (version.error || version.status !== 0) {
    return {
      name: 'auth',
      status: 'fail',
      message: `Codex CLI is not ready: ${summarizeFailure(version, 'codex --version failed')}`,
      details: { phase: 'codex-cli', exit_code: version.status },
    };
  }

  const login = run('codex', ['login', 'status'], { cwd, env });
  if (login.error || login.status !== 0) {
    return {
      name: 'auth',
      status: 'fail',
      message: `codex login status failed: ${summarizeFailure(login, 'login status failed')}`,
      details: { phase: 'login-status', exit_code: login.status },
    };
  }

  const versionLine = (version.stdout || '').trim().split(/\r?\n/)[0] || 'codex present';
  return {
    name: 'auth',
    status: 'pass',
    message: `Codex CLI and login status are OK (${versionLine})`,
  };
}

function runExecCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
  run: ReadyCommandRunner,
  skipExec: boolean,
): ReadyCheck {
  if (skipExec) {
    return {
      name: 'exec',
      status: 'skip',
      message: 'skipped by --skip-exec; no model call was made',
    };
  }

  const command = makeSelfCommandArgs([
    'exec',
    '--skip-git-repo-check',
    '-C',
    cwd,
    EXEC_SMOKE_PROMPT,
  ]);
  const result = run(command.command, command.args, { cwd, env });
  if (result.error || result.status !== 0) {
    return {
      name: 'exec',
      status: 'fail',
      message: `omx exec smoke failed: ${summarizeFailure(result, 'exec smoke failed')}`,
      details: { exit_code: result.status },
    };
  }
  if (!result.stdout.includes(EXEC_SMOKE_TOKEN)) {
    return {
      name: 'exec',
      status: 'fail',
      message: `omx exec completed but did not return ${EXEC_SMOKE_TOKEN}`,
      details: { stdout: result.stdout.trim().slice(0, 500) },
    };
  }
  return {
    name: 'exec',
    status: 'pass',
    message: `omx exec returned ${EXEC_SMOKE_TOKEN}`,
  };
}

function windowsRuntimeCheck(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadyCheck {
  if (!isNativeWindowsRuntime(platform, env)) {
    return {
      name: 'windows-runtime',
      status: 'pass',
      message: 'not running on native Windows',
    };
  }

  const shellHint = isPowerShellLike(env) ? 'PowerShell detected' : 'native Windows detected';
  return {
    name: 'windows-runtime',
    status: 'warn',
    message:
      `${shellHint}; Windows uses the watcher-first runtime. ` +
      'Treat omx sparkshell as the primary shell helper; the built-in omx explore harness is not the main Windows PowerShell path.',
  };
}

function teamRuntimeCheck(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  tmuxResolver: NonNullable<ReadyDependencies['tmuxResolver']>,
): ReadyCheck {
  const tmuxPath = tmuxResolver(platform, env);
  if (tmuxPath) {
    return {
      name: 'team-runtime',
      status: 'pass',
      message: `tmux-compatible binary found (${tmuxPath})`,
    };
  }

  if (isNativeWindowsRuntime(platform, env)) {
    return {
      name: 'team-runtime',
      status: 'warn',
      message: 'native Windows team/tmux features need psmux, or use WSL2 with tmux for the recommended team path',
    };
  }

  return {
    name: 'team-runtime',
    status: 'warn',
    message: 'tmux not found; omx team is unavailable until tmux is installed',
  };
}

export async function collectReadyReport(
  options: ReadyOptions = {},
  deps: ReadyDependencies = {},
): Promise<ReadyReport> {
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const run = deps.commandRunner || defaultCommandRunner;
  const tmuxResolver = deps.tmuxResolver || resolveTmuxBinaryForPlatform;
  const checks = [
    runInstallCheck(cwd, env, run),
    runAuthCheck(cwd, env, run),
    runExecCheck(cwd, env, run, options.skipExec === true),
    windowsRuntimeCheck(platform, env),
    teamRuntimeCheck(platform, env, tmuxResolver),
  ];
  const ok = checks.every((check) => check.status !== 'fail');
  return {
    command: 'omx ready',
    ok,
    cwd,
    skipped_exec: options.skipExec === true,
    checks,
  };
}

function parseReadyArgs(args: string[]): ReadyOptions {
  const allowed = new Set(['--json', '--skip-exec', '--help', '-h']);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown omx ready option: ${arg}`);
    }
  }
  return {
    json: args.includes('--json'),
    skipExec: args.includes('--skip-exec'),
  };
}

function printReadyHelp(writeOut: (line: string) => void): void {
  writeOut(`omx ready - Check install, auth, exec smoke, and platform runtime readiness

Usage:
  omx ready [--json] [--skip-exec]

Options:
  --json       Print stable JSON for CI or tests
  --skip-exec  Skip the real omx exec model-call smoke`);
}

function printReadyReport(report: ReadyReport, writeOut: (line: string) => void): void {
  writeOut('oh-my-codex ready');
  writeOut('=================\n');
  for (const check of report.checks) {
    const icon =
      check.status === 'pass'
        ? '[OK]'
        : check.status === 'warn'
          ? '[!!]'
          : check.status === 'skip'
            ? '[--]'
            : '[XX]';
    writeOut(`  ${icon} ${check.name}: ${check.message}`);
  }
  writeOut('');
  writeOut(report.ok ? 'Ready: yes' : 'Ready: no');
  if (!report.skipped_exec) {
    writeOut('Exec smoke: real model call attempted.');
  }
}

export async function readyCommand(
  args: string[],
  deps: ReadyDependencies = {},
): Promise<void> {
  const writeOut = deps.writeOut || ((line: string) => console.log(line));
  if (args.includes('--help') || args.includes('-h')) {
    printReadyHelp(writeOut);
    return;
  }

  const options = parseReadyArgs(args);
  const report = await collectReadyReport(options, deps);
  if (options.json) {
    writeOut(JSON.stringify(report, null, 2));
  } else {
    printReadyReport(report, writeOut);
  }
  if (!report.ok) process.exitCode = 1;
}
