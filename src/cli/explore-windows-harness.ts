import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SPARK_MODEL,
  DEFAULT_STANDARD_MODEL,
  getEnvConfiguredSparkDefaultModel,
  getEnvConfiguredStandardDefaultModel,
  getSparkDefaultModel,
  getStandardDefaultModel,
  readConfiguredEnvOverrides,
} from '../config/models.js';
import { promptSurfaceSkillPath } from '../utils/prompt-surface.js';
import { getPackageRoot } from '../utils/package.js';
import { buildPlatformCommandSpec, resolveCommandPathForPlatform } from '../utils/platform-command.js';

const CODEX_BIN_ENV = 'OMX_EXPLORE_CODEX_BIN';
const CODEX_TIMEOUT_MS_ENV = 'OMX_EXPLORE_CODEX_TIMEOUT_MS';
const EXPLORE_HOST_PATH_ENV = 'OMX_EXPLORE_HOST_PATH';
const EXPLORE_ROOT_ENV = 'OMX_EXPLORE_ROOT';
const EXPLORE_SPARK_MODEL_ENV = 'OMX_EXPLORE_SPARK_MODEL';
const EXPLORE_INSTRUCTIONS_FILE_ENV = 'OMX_EXPLORE_MODEL_INSTRUCTIONS_FILE';
const EXPLORE_TRACE_FILE_ENV = 'OMX_EXPLORE_WINDOWS_TRACE_FILE';
const DEFAULT_CODEX_TIMEOUT_MS = 180_000;
const EXPLORE_SUBPROCESS_ENV_VARS_TO_SCRUB = [
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'PSModuleAnalysisCachePath',
  'RIPGREP_CONFIG_PATH',
];
const ALLOWED_DIRECT_COMMANDS = new Set([
  'rg',
  'grep',
  'ls',
  'find',
  'wc',
  'cat',
  'head',
  'tail',
  'pwd',
  'printf',
]);
const DISALLOWED_FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
const SHELL_PROXY_NAMES = ['powershell', 'pwsh', 'cmd'] as const;
const WINDOWS_LINE_ENDING = '\r\n';

export interface WindowsHarnessArgs {
  cwd: string;
  prompt: string;
  promptFile: string;
  instructionsFile: string;
  sparkModel: string;
  fallbackModel: string;
}

interface ProbeOptions {
  mode: 'entrypoint' | 'codex-launch' | 'tooling';
  outputPath?: string;
}

interface ParseResult {
  kind: 'run' | 'probe' | 'internal-direct' | 'internal-shell';
  args?: WindowsHarnessArgs;
  probe?: ProbeOptions;
  commandName?: string;
  shellName?: string;
  forwardedArgs?: string[];
}

interface AttemptResult {
  statusCode: number;
  stderr: string;
  outputMarkdown?: string;
}

interface FallbackEvent {
  fromModel: string;
  toModel: string;
  exitCode: number;
  stderr: string;
}

interface AllowlistRuntime {
  binDir: string;
  rootDir: string;
  dispose(): void;
}

interface CommandExecutionResult {
  stdout?: string;
  stderr?: string;
  statusCode: number;
}

interface SpawnWithTimeoutResult {
  statusCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function usage(): string {
  return [
    'Usage: explore-windows-harness --cwd <dir> --prompt <text> --prompt-file <path> --instructions-file <path> --model-spark <model> --model-fallback <model>',
    '   or: explore-windows-harness --probe <entrypoint|codex-launch|tooling> [--probe-output <path>]',
  ].join('\n');
}

function traceHarness(event: string, payload: Record<string, unknown> = {}): void {
  const tracePath = process.env[EXPLORE_TRACE_FILE_ENV]?.trim();
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`, 'utf-8');
}

function nextRequired(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`missing value after ${flag}\n${usage()}`);
  return value;
}

export function parseWindowsHarnessArgs(argv: string[]): ParseResult {
  if (argv.length >= 2 && argv[0] === '--internal-direct') {
    return {
      kind: 'internal-direct',
      commandName: argv[1],
      forwardedArgs: argv.slice(2),
    };
  }

  if (argv.length >= 2 && argv[0] === '--internal-shell') {
    return {
      kind: 'internal-shell',
      shellName: argv[1],
      forwardedArgs: argv.slice(2),
    };
  }

  const probeIndex = argv.indexOf('--probe');
  if (probeIndex >= 0) {
    const mode = nextRequired(argv, probeIndex, '--probe') as ProbeOptions['mode'];
    if (!['entrypoint', 'codex-launch', 'tooling'].includes(mode)) {
      throw new Error(`unknown probe mode: ${mode}\n${usage()}`);
    }
    const outputIndex = argv.indexOf('--probe-output');
    const outputPath = outputIndex >= 0 ? nextRequired(argv, outputIndex, '--probe-output') : undefined;
    return { kind: 'probe', probe: { mode, outputPath } };
  }

  let cwd = '';
  let prompt = '';
  let promptFile = '';
  let instructionsFile = '';
  let sparkModel = '';
  let fallbackModel = '';

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--cwd':
        cwd = nextRequired(argv, i, '--cwd');
        i += 1;
        break;
      case '--prompt':
        prompt = nextRequired(argv, i, '--prompt');
        i += 1;
        break;
      case '--prompt-file':
        promptFile = nextRequired(argv, i, '--prompt-file');
        i += 1;
        break;
      case '--instructions-file':
        instructionsFile = nextRequired(argv, i, '--instructions-file');
        i += 1;
        break;
      case '--model-spark':
        sparkModel = nextRequired(argv, i, '--model-spark');
        i += 1;
        break;
      case '--model-fallback':
        fallbackModel = nextRequired(argv, i, '--model-fallback');
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${token}\n${usage()}`);
    }
  }

  if (!cwd || !prompt || !promptFile || !instructionsFile || !sparkModel || !fallbackModel) {
    throw new Error(`missing required arguments\n${usage()}`);
  }

  return {
    kind: 'run',
    args: {
      cwd,
      prompt,
      promptFile,
      instructionsFile,
      sparkModel,
      fallbackModel,
    },
  };
}

function fallbackAttemptEventMessage(event: FallbackEvent): string {
  return `[omx explore] fallback-attempt=model from=\`${event.fromModel}\` to=\`${event.toModel}\` reason=spark_attempt_failed exit=${event.exitCode}. Cost/behavior boundary changed if fallback succeeds; stdout fallback notice is emitted only after successful fallback output.`;
}

function fallbackOutputNotice(event: FallbackEvent): string {
  return [
    '## OMX Explore fallback',
    '- fallback: model',
    `- from: \`${event.fromModel}\``,
    `- to: \`${event.toModel}\``,
    `- reason: spark attempt failed with exit ${event.exitCode}`,
    '- boundary: cost/behavior may differ from the low-cost spark path',
  ].join('\n');
}

function emitModelFallbackEvent(event: FallbackEvent): void {
  process.stderr.write(`${fallbackAttemptEventMessage(event)}\n`);
  process.stderr.write(
    `[omx explore] spark model \`${event.fromModel}\` unavailable or failed (exit ${event.exitCode}). Falling back to \`${event.toModel}\`.\n`,
  );
  if (event.stderr.trim()) {
    process.stderr.write(`[omx explore] spark stderr: ${event.stderr.trim()}\n`);
  }
}

function discoverCodexSupportDirs(): string[] {
  const dirs: string[] = [];
  const home = process.env.HOME?.trim();
  if (!home) return dirs;
  for (const relativeDir of ['.omx', '.codex']) {
    const dir = join(home, relativeDir);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      dirs.push(dir);
    }
  }
  return dirs;
}

function codexSupportDirArgs(): string[] {
  return discoverCodexSupportDirs().flatMap((dir) => ['--add-dir', dir]);
}

function tempOutputPath(): string {
  return join(tmpdir(), `omx-explore-win-${process.pid}-${Date.now()}.md`);
}

function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clone = { ...env };
  for (const key of EXPLORE_SUBPROCESS_ENV_VARS_TO_SCRUB) {
    delete clone[key];
  }
  return clone;
}

function composeWindowsExecPrompt(userPrompt: string, promptContract: string): string {
  const seedContext = formatRepositorySeedContext(userPrompt);
  return [
    'You are OMX Explore, a low-cost read-only repository exploration harness for native Windows.',
    'Operate strictly in read-only mode. You may use repository-inspection shell commands only.',
    'Preferred commands: rg, grep, and tightly bounded read-only Windows-native wrappers over rg/grep/ls/find/wc/cat/head/tail/pwd/printf.',
    'Prefer bare allowlisted commands such as `rg OMX_EXPLORE_BIN src`, `find src -name "*.ts"`, `pwd`, or `cat path/to/file`.',
    'The environment is configured to allow those bare commands. You are expected to run them before answering.',
    'Do not rely on PowerShell aliases, PowerShell cmdlets (`Get-ChildItem`, `Select-String`, `Get-Content`), GNU userland, Git Bash, or WSL.',
    'Do not invoke broad shell workflows when a direct allowlisted command can answer the request. If you must invoke a shell wrapper, the inner command must still be a single bare allowlisted command.',
    'Do not claim that shell inspection was blocked by policy unless an allowlisted command actually failed and you can cite that stderr in the answer.',
    'Do not write, delete, rename, or modify files. Do not run git commands that alter working state.',
    'Always return markdown only.',
    '',
    'Reference behavior contract:',
    '---------------- BEGIN EXPLORE PROMPT ----------------',
    promptContract,
    '---------------- END EXPLORE PROMPT ----------------',
    '',
    ...(seedContext ? [seedContext, ''] : []),
    'User request:',
    userPrompt,
    '',
  ].join('\n');
}

function extractSeedTerms(prompt: string): string[] {
  const terms = new Set<string>();
  for (const match of prompt.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim();
    if (value) terms.add(value);
  }
  for (const match of prompt.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    terms.add(match[0]);
  }
  return [...terms].slice(0, 3);
}

function runHostSeedSearch(term: string): string[] {
  const rgPath = resolveCommandPathForPlatform('rg', process.platform, process.env);
  if (!rgPath) return [];
  const result = spawnSync(rgPath, ['--no-config', '-n', '--no-heading', '--fixed-strings', term, '.'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...sanitizeEnv(process.env),
      RIPGREP_CONFIG_PATH: '',
    },
  });
  if ((result.status ?? 1) > 1) return [];
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatRepositorySeedContext(prompt: string): string | null {
  const lines: string[] = [];
  for (const term of extractSeedTerms(prompt)) {
    const matches = runHostSeedSearch(term);
    if (matches.length === 0) continue;
    lines.push(`- term: \`${term}\``);
    for (const match of matches) {
      lines.push(`  - ${match}`);
    }
  }
  if (lines.length === 0) return null;
  return [
    '[Repository Seed Matches]',
    'Use these concrete repository matches first before deciding that shell inspection is blocked or unavailable.',
    ...lines,
  ].join('\n');
}

function codexTimeoutMs(): number {
  const parsed = Number.parseInt(process.env[CODEX_TIMEOUT_MS_ENV] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_TIMEOUT_MS;
}

function shouldUseWindowsVerbatimArguments(resolvedPath: string | undefined): boolean {
  return typeof resolvedPath === 'string' && ['.cmd', '.bat'].includes(extname(resolvedPath).toLowerCase());
}

function resolveCodexCommand(): string {
  const override = process.env[CODEX_BIN_ENV]?.trim();
  return override || 'codex';
}

function buildCodexLaunchSpec(args: WindowsHarnessArgs, model: string, finalPrompt: string, outputPath: string): {
  command: string;
  args: string[];
  resolvedPath?: string;
} {
  const codexArgs = [
    'exec',
    '-C',
    args.cwd,
    ...codexSupportDirArgs(),
    '-m',
    model,
    '-s',
    'read-only',
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    `model_instructions_file="${args.instructionsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
    '-c',
    'shell_environment_policy.inherit=all',
    '--skip-git-repo-check',
    '-o',
    outputPath,
    finalPrompt,
  ];
  return buildPlatformCommandSpec(resolveCodexCommand(), codexArgs, process.platform, process.env);
}

function writeCmdWrapper(targetPath: string, contentLines: string[]): void {
  writeFileSync(targetPath, contentLines.join(WINDOWS_LINE_ENDING), 'utf-8');
}

function currentScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

function quoteCmdArg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function createAllowlistRuntime(): AllowlistRuntime {
  const rootDir = mkdtempSync(join(tmpdir(), 'omx-explore-win-'));
  const binDir = join(rootDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = currentScriptPath();
  const nodePath = process.execPath;
  const escapedScript = quoteCmdArg(scriptPath);
  const escapedNode = quoteCmdArg(nodePath);
  const writeWrapper = (name: string, kind: 'direct' | 'shell', target: string): void => {
    writeCmdWrapper(join(binDir, `${name}.cmd`), [
      '@echo off',
      'setlocal',
      `${escapedNode} ${escapedScript} --internal-${kind} ${quoteCmdArg(target)} %*`,
    ]);
  };

  for (const command of ALLOWED_DIRECT_COMMANDS) {
    writeWrapper(command, 'direct', command);
  }
  for (const shellName of SHELL_PROXY_NAMES) {
    writeWrapper(shellName, 'shell', shellName);
  }

  return {
    rootDir,
    binDir,
    dispose() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function writeProbeOutput(probe: ProbeOptions, payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  if (probe.outputPath) {
    writeFileSync(probe.outputPath, json, 'utf-8');
  }
  process.stdout.write(`${json}\n`);
}

function runProbe(probe: ProbeOptions): void {
  if (probe.mode === 'entrypoint') {
    writeProbeOutput(probe, {
      mode: probe.mode,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH || process.env.Path || '',
        PATHEXT: process.env.PATHEXT || '',
        ComSpec: process.env.ComSpec || '',
        CODEX_HOME: process.env.CODEX_HOME || '',
      },
      platform: process.platform,
    });
    return;
  }

  if (probe.mode === 'codex-launch') {
    const outputPath = tempOutputPath();
    const dummyArgs: WindowsHarnessArgs = {
      cwd: process.cwd(),
      prompt: 'probe codex launch',
      promptFile: 'probe.md',
      instructionsFile: 'instructions.md',
      sparkModel: 'probe-spark',
      fallbackModel: 'probe-fallback',
    };
    const payload = buildCodexLaunchSpec(dummyArgs, dummyArgs.sparkModel, 'probe', outputPath);
    writeProbeOutput(probe, payload);
    return;
  }

  const runtime = createAllowlistRuntime();
  try {
    writeProbeOutput(probe, {
      mode: probe.mode,
      binDir: runtime.binDir,
      wrappers: readdirSync(runtime.binDir).sort(),
      hostPath: process.env.PATH || process.env.Path || '',
    });
  } finally {
    runtime.dispose();
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

async function spawnWithTimeout(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    resolvedPath?: string;
  },
  timeoutMs: number,
): Promise<SpawnWithTimeoutResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: shouldUseWindowsVerbatimArguments(options.resolvedPath),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: SpawnWithTimeoutResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolvePromise(result);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      finish({
        statusCode: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
        timedOut,
      });
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid ?? 0);
    }, timeoutMs);
  });
}

async function invokeCodex(args: WindowsHarnessArgs, model: string, promptContract: string): Promise<AttemptResult> {
  const runtime = createAllowlistRuntime();
  const outputPath = tempOutputPath();
  const finalPrompt = composeWindowsExecPrompt(args.prompt, promptContract);
  const launchSpec = buildCodexLaunchSpec(args, model, finalPrompt, outputPath);
  const env = sanitizeEnv({
    ...process.env,
    PATH: `${runtime.binDir}${delimiter}`,
    [EXPLORE_HOST_PATH_ENV]: process.env.PATH || process.env.Path || '',
    [EXPLORE_ROOT_ENV]: args.cwd,
  });

  try {
    traceHarness('invoke-codex', { model, command: launchSpec.command, args: launchSpec.args });
    const result = await spawnWithTimeout(
      launchSpec.command,
      launchSpec.args,
      {
        cwd: args.cwd,
        env,
        resolvedPath: launchSpec.resolvedPath,
      },
      codexTimeoutMs(),
    );
    const outputMarkdown = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : undefined;
    rmSync(outputPath, { force: true });
    if (result.timedOut) {
      return {
        statusCode: 124,
        stderr: `[omx explore] codex exec timed out after ${codexTimeoutMs()}ms; terminated process tree${result.stderr.trim() ? `. stderr before timeout: ${result.stderr.trim()}` : ''}`,
      };
    }
    return {
      statusCode: result.statusCode,
      stderr: result.stderr,
      outputMarkdown,
    };
  } finally {
    runtime.dispose();
    rmSync(outputPath, { force: true });
  }
}

function printAttemptOutput(attempt: AttemptResult, fallback?: FallbackEvent): void {
  if (!attempt.outputMarkdown) {
    throw new Error('codex completed successfully but did not produce the expected markdown output artifact');
  }
  if (fallback) {
    process.stdout.write(`${fallbackOutputNotice(fallback)}\n`);
  }
  process.stdout.write(attempt.outputMarkdown);
}

function normalizePathCase(pathValue: string): string {
  return process.platform === 'win32' ? pathValue.toLowerCase() : pathValue;
}

function normalizeCandidatePath(repoRoot: string, operand: string): string {
  return normalize(isAbsolute(operand) ? operand : resolve(repoRoot, operand));
}

function existingAncestor(pathValue: string): string | null {
  let current = pathValue;
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function canonicalizeExistingPrefix(pathValue: string): string | null {
  const ancestor = existingAncestor(pathValue);
  if (!ancestor) return null;
  try {
    return normalize(realpathSync.native ? realpathSync.native(ancestor) : realpathSync(ancestor));
  } catch {
    return null;
  }
}

function isPathWithinRepo(repoRoot: string, operand: string): boolean {
  const normalizedRepoRoot = normalize(resolve(repoRoot));
  const normalizedCandidate = normalizeCandidatePath(normalizedRepoRoot, operand);
  const repoRootKey = normalizePathCase(normalizedRepoRoot.endsWith(sep) ? normalizedRepoRoot : `${normalizedRepoRoot}${sep}`);
  const candidateKey = normalizePathCase(normalizedCandidate);
  const textuallyInside =
    candidateKey === normalizePathCase(normalizedRepoRoot) ||
    candidateKey.startsWith(repoRootKey);
  if (!textuallyInside) return false;

  const repoReal = canonicalizeExistingPrefix(normalizedRepoRoot);
  const candidateReal = canonicalizeExistingPrefix(normalizedCandidate);
  if (repoReal && candidateReal) {
    const repoRealKey = normalizePathCase(repoReal.endsWith(sep) ? repoReal : `${repoReal}${sep}`);
    const candidateRealKey = normalizePathCase(candidateReal);
    if (candidateRealKey !== normalizePathCase(repoReal) && !candidateRealKey.startsWith(repoRealKey)) {
      return false;
    }
  }
  return true;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function nonOptionOperands(args: string[]): string[] {
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) {
      operands.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') continue;
    operands.push(arg);
  }
  return operands;
}

function commandPathOperands(commandName: string, args: string[]): string[] {
  const operands = nonOptionOperands(args);
  switch (commandName) {
    case 'rg':
    case 'grep':
      return operands.slice(1);
    case 'find': {
      const paths: string[] = [];
      for (const arg of args) {
        if (arg.startsWith('-') || ['!', '(', ')'].includes(arg)) break;
        paths.push(arg);
      }
      return paths;
    }
    case 'ls':
    case 'cat':
    case 'head':
    case 'tail':
    case 'wc':
      return operands;
    default:
      return [];
  }
}

function validateRepoPaths(commandName: string, args: string[]): void {
  const repoRoot = process.env[EXPLORE_ROOT_ENV]?.trim();
  if (!repoRoot) return;
  for (const operand of commandPathOperands(commandName, args)) {
    if (!isPathWithinRepo(repoRoot, operand)) {
      throw new Error(`path \`${operand}\` escapes the omx explore repository root ${repoRoot}`);
    }
  }
}

function validateDirectCommand(commandName: string, args: string[]): void {
  if (!ALLOWED_DIRECT_COMMANDS.has(commandName)) {
    throw new Error(`command \`${commandName}\` is not on the omx explore allowlist`);
  }
  switch (commandName) {
    case 'rg':
      if (args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) {
        throw new Error('ripgrep `--pre` is not allowed in omx explore');
      }
      if (args.includes('-')) {
        throw new Error('ripgrep stdin (`-`) is not allowed in omx explore');
      }
      break;
    case 'grep': {
      if (args.includes('-')) throw new Error('grep stdin (`-`) is not allowed in omx explore');
      if (nonOptionOperands(args).length < 2) {
        throw new Error('grep requires a pattern and at least one file/path in omx explore');
      }
      break;
    }
    case 'find':
      if (args.some((arg) => DISALLOWED_FIND_ACTIONS.has(arg))) {
        throw new Error('find actions that execute, delete, or write files are not allowed in omx explore');
      }
      break;
    case 'cat': {
      const operands = nonOptionOperands(args);
      if (operands.length === 0) throw new Error('cat requires at least one file/path in omx explore');
      if (operands.includes('-')) throw new Error('cat stdin (`-`) is not allowed in omx explore');
      break;
    }
    case 'head':
    case 'wc': {
      const operands = nonOptionOperands(args);
      if (operands.length === 0) throw new Error(`${commandName} requires at least one file/path in omx explore`);
      if (operands.includes('-')) throw new Error(`${commandName} stdin (\`-\`) is not allowed in omx explore`);
      break;
    }
    case 'tail': {
      const operands = nonOptionOperands(args);
      if (operands.length === 0) throw new Error('tail requires at least one file/path in omx explore');
      if (operands.includes('-')) throw new Error('tail stdin (`-`) is not allowed in omx explore');
      if (args.some((arg) => ['-f', '-F', '--retry'].includes(arg) || arg.startsWith('--follow'))) {
        throw new Error('tail follow/retry modes are not allowed in omx explore');
      }
      break;
    }
    case 'pwd':
      if (args.length > 0) throw new Error('pwd does not accept arguments in omx explore');
      break;
    default:
      break;
  }
  validateRepoPaths(commandName, args);
}

function validateShellCommand(command: string): { commandName: string; args: string[] } {
  if (!command.trim()) throw new Error('shell wrapper received an empty command');
  for (const fragment of ['\n', '\r', '&&', '||', ';', '|', '>', '<', '`', '$(', '${', '%', '^', '&']) {
    if (command.includes(fragment)) {
      throw new Error(`shell wrapper rejected disallowed fragment \`${fragment}\` in \`${command}\``);
    }
  }
  const tokens = tokenizeShellCommand(command);
  const [first, ...rest] = tokens;
  if (!first) throw new Error('shell wrapper could not determine the command name');
  if (first.includes('/') || first.includes('\\') || first.includes(':')) {
    throw new Error(`shell wrapper rejected path-qualified command \`${first}\`; use allowlisted bare commands only`);
  }
  validateDirectCommand(first, rest);
  return { commandName: first, args: rest };
}

function extractPowerShellCommand(args: string[]): string {
  let command = '';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (['-NoLogo', '-NoProfile'].includes(token)) continue;
    if (token === '-ExecutionPolicy') {
      i += 1;
      continue;
    }
    if (token === '-Command' || token === '-c') {
      command = args[i + 1] || '';
      i += 1;
      continue;
    }
    throw new Error(`unsupported PowerShell proxy argument: ${token}`);
  }
  if (!command) throw new Error('PowerShell proxy requires -Command/-c');
  return command;
}

function extractCmdCommand(args: string[]): string {
  let command = '';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i].toLowerCase();
    if (token === '/d' || token === '/s') continue;
    if (token === '/c') {
      command = args[i + 1] || '';
      i += 1;
      continue;
    }
    throw new Error(`unsupported cmd proxy argument: ${args[i]}`);
  }
  if (!command) throw new Error('cmd proxy requires /c');
  return command;
}

function pathToDisplay(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath) || '.';
  return rel.split(sep).join('/');
}

function listFilesRecursively(rootPath: string): string[] {
  const results: string[] = [];
  const walk = (currentPath: string): void => {
    const stat = statSync(currentPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
        walk(join(currentPath, entry.name));
      }
      return;
    }
    results.push(currentPath);
  };
  walk(rootPath);
  return results;
}

function simpleWildcardToRegExp(pattern: string, ignoreCase = false): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, ignoreCase ? 'i' : '');
}

function runRg(args: string[]): CommandExecutionResult {
  const hostPath = process.env[EXPLORE_HOST_PATH_ENV] || process.env.PATH || '';
  const resolved = resolveCommandPathForPlatform('rg', process.platform, {
    ...process.env,
    PATH: hostPath,
    Path: hostPath,
  });
  if (!resolved) {
    return {
      statusCode: 127,
      stderr: 'omx explore allowlisted host command `rg` is unavailable on this host',
    };
  }
  const result = spawnSync(resolved, ['--no-config', ...args], {
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...sanitizeEnv(process.env),
      PATH: hostPath,
      Path: hostPath,
      RIPGREP_CONFIG_PATH: '',
    },
  });
  return {
    statusCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runPwd(): CommandExecutionResult {
  return { statusCode: 0, stdout: `${process.cwd()}\n` };
}

function runPrintf(args: string[]): CommandExecutionResult {
  const [format = '', ...values] = args;
  let index = 0;
  const rendered = format
    .replace(/%s/g, () => values[index++] ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  return { statusCode: 0, stdout: rendered };
}

function runLs(args: string[]): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const showAll = args.includes('-a') || args.includes('-A');
  const paths = nonOptionOperands(args).length > 0 ? nonOptionOperands(args) : ['.'];
  const lines: string[] = [];
  for (const operand of paths) {
    const target = normalizeCandidatePath(repoRoot, operand);
    if (!existsSync(target)) {
      return { statusCode: 2, stderr: `ls: cannot access '${operand}': No such file or directory\n` };
    }
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      lines.push(pathToDisplay(repoRoot, target));
      continue;
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!showAll && entry.name.startsWith('.')) continue;
      const entryPath = join(target, entry.name);
      lines.push(pathToDisplay(repoRoot, entryPath));
    }
  }
  return { statusCode: 0, stdout: `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}` };
}

function readTextFile(pathValue: string): string {
  return readFileSync(pathValue, 'utf-8');
}

function runCat(args: string[]): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const outputs: string[] = [];
  for (const operand of nonOptionOperands(args)) {
    const target = normalizeCandidatePath(repoRoot, operand);
    outputs.push(readTextFile(target));
  }
  return { statusCode: 0, stdout: outputs.join('') };
}

function parseCountFlag(args: string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-n') return Number.parseInt(args[index + 1] || '10', 10);
    if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10);
  }
  return 10;
}

function runHeadOrTail(args: string[], mode: 'head' | 'tail'): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const count = parseCountFlag(args);
  const files = nonOptionOperands(args);
  const outputs: string[] = [];
  for (const operand of files) {
    const target = normalizeCandidatePath(repoRoot, operand);
    const lines = readTextFile(target).split(/\r?\n/);
    const effective = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    const sliced = mode === 'head' ? effective.slice(0, count) : effective.slice(Math.max(0, effective.length - count));
    outputs.push(`${sliced.join('\n')}\n`);
  }
  return { statusCode: 0, stdout: outputs.join('') };
}

function runWc(args: string[]): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const countLinesOnly = args.includes('-l');
  const outputs: string[] = [];
  for (const operand of nonOptionOperands(args)) {
    const target = normalizeCandidatePath(repoRoot, operand);
    const text = readTextFile(target);
    const lineCount = text === '' ? 0 : text.split(/\r?\n/).filter((line, index, lines) => !(index === lines.length - 1 && line === '')).length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const byteCount = Buffer.byteLength(text);
    const display = pathToDisplay(repoRoot, target);
    outputs.push(countLinesOnly ? `${lineCount} ${display}` : `${lineCount} ${wordCount} ${byteCount} ${display}`);
  }
  return { statusCode: 0, stdout: `${outputs.join('\n')}\n` };
}

function enumerateSearchFiles(target: string, recursive: boolean): string[] {
  const stat = statSync(target);
  if (stat.isDirectory()) {
    if (!recursive) {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry: { isFile(): boolean }) => entry.isFile())
        .map((entry: { name: string }) => join(target, entry.name));
    }
    return listFilesRecursively(target);
  }
  return [target];
}

function formatGrepMatches(repoRoot: string, filePath: string, matches: Array<{ lineNumber: number; line: string }>, includeLineNumbers: boolean): string[] {
  const display = pathToDisplay(repoRoot, filePath);
  return matches.map(({ lineNumber, line }) => (
    includeLineNumbers ? `${display}:${lineNumber}:${line}` : `${display}:${line}`
  ));
}

function runGrep(args: string[]): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const operands = nonOptionOperands(args);
  const [pattern, ...paths] = operands;
  const recursive = args.includes('-r') || args.includes('-R');
  const includeLineNumbers = args.includes('-n');
  const ignoreCase = args.includes('-i');
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const results: string[] = [];
  for (const operand of paths) {
    const target = normalizeCandidatePath(repoRoot, operand);
    for (const filePath of enumerateSearchFiles(target, recursive)) {
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) continue;
      const lines = readTextFile(filePath).split(/\r?\n/);
      const matches = lines
        .map((line, index) => ({ lineNumber: index + 1, line }))
        .filter(({ line }) => regex.test(line));
      results.push(...formatGrepMatches(repoRoot, filePath, matches, includeLineNumbers));
    }
  }
  return { statusCode: results.length > 0 ? 0 : 1, stdout: results.length > 0 ? `${results.join('\n')}\n` : '' };
}

function runFind(args: string[]): CommandExecutionResult {
  const repoRoot = process.env[EXPLORE_ROOT_ENV] || process.cwd();
  const paths: string[] = [];
  let namePattern: string | undefined;
  let caseInsensitive = false;
  let typeFilter: 'f' | 'd' | undefined;
  let maxDepth = Number.POSITIVE_INFINITY;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-name') {
      namePattern = args[index + 1];
      index += 1;
      continue;
    }
    if (token === '-iname') {
      namePattern = args[index + 1];
      caseInsensitive = true;
      index += 1;
      continue;
    }
    if (token === '-type') {
      const typeArg = args[index + 1];
      if (typeArg === 'f' || typeArg === 'd') typeFilter = typeArg;
      index += 1;
      continue;
    }
    if (token === '-maxdepth') {
      maxDepth = Number.parseInt(args[index + 1] || '0', 10);
      index += 1;
      continue;
    }
    if (!token.startsWith('-') && !['!', '(', ')'].includes(token)) {
      paths.push(token);
    }
  }

  const matcher = namePattern ? simpleWildcardToRegExp(namePattern, caseInsensitive) : null;
  const roots = paths.length > 0 ? paths : ['.'];
  const results: string[] = [];
  const walk = (currentPath: string, depth: number): void => {
    const stat = statSync(currentPath);
    const name = basename(currentPath);
    const typeMatches = !typeFilter || (typeFilter === 'f' ? stat.isFile() : stat.isDirectory());
    const nameMatches = !matcher || matcher.test(name);
    if (typeMatches && nameMatches) {
      results.push(pathToDisplay(repoRoot, currentPath));
    }
    if (!stat.isDirectory() || depth >= maxDepth) return;
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      walk(join(currentPath, entry.name), depth + 1);
    }
  };
  for (const operand of roots) {
    walk(normalizeCandidatePath(repoRoot, operand), 0);
  }
  return { statusCode: 0, stdout: `${results.join('\n')}${results.length > 0 ? '\n' : ''}` };
}

function runDirectCommand(commandName: string, args: string[]): CommandExecutionResult {
  traceHarness('direct-command', { commandName, args });
  validateDirectCommand(commandName, args);
  switch (commandName) {
    case 'rg':
      return runRg(args);
    case 'grep':
      return runGrep(args);
    case 'ls':
      return runLs(args);
    case 'find':
      return runFind(args);
    case 'wc':
      return runWc(args);
    case 'cat':
      return runCat(args);
    case 'head':
      return runHeadOrTail(args, 'head');
    case 'tail':
      return runHeadOrTail(args, 'tail');
    case 'pwd':
      return runPwd();
    case 'printf':
      return runPrintf(args);
    default:
      throw new Error(`unsupported command: ${commandName}`);
  }
}

function executeShellProxy(shellName: string, forwardedArgs: string[]): CommandExecutionResult {
  traceHarness('shell-proxy', { shellName, forwardedArgs });
  const command =
    shellName === 'cmd'
      ? extractCmdCommand(forwardedArgs)
      : extractPowerShellCommand(forwardedArgs);
  const validated = validateShellCommand(command);
  return runDirectCommand(validated.commandName, validated.args);
}

async function runHarness(args: WindowsHarnessArgs): Promise<void> {
  const promptContract = await readFile(args.promptFile, 'utf-8');
  const sparkAttempt = await invokeCodex(args, args.sparkModel, promptContract);
  if (sparkAttempt.statusCode === 0) {
    printAttemptOutput(sparkAttempt);
    return;
  }

  const fallbackEvent: FallbackEvent = {
    fromModel: args.sparkModel,
    toModel: args.fallbackModel,
    exitCode: sparkAttempt.statusCode,
    stderr: sparkAttempt.stderr,
  };
  emitModelFallbackEvent(fallbackEvent);
  const fallbackAttempt = await invokeCodex(args, args.fallbackModel, promptContract);
  if (fallbackAttempt.statusCode === 0) {
    printAttemptOutput(fallbackAttempt, fallbackEvent);
    return;
  }

  process.stderr.write(
    `[omx explore] both spark (\`${args.sparkModel}\`) and fallback (\`${args.fallbackModel}\`) attempts failed (codes ${sparkAttempt.statusCode} / ${fallbackAttempt.statusCode}). Last stderr: ${fallbackAttempt.stderr.trim()}\n`,
  );
  process.exitCode = 1;
}

export async function runWindowsExploreHarnessCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseWindowsHarnessArgs(argv);
  switch (parsed.kind) {
    case 'probe':
      runProbe(parsed.probe!);
      return;
    case 'internal-direct': {
      assert(parsed.commandName);
      let result: CommandExecutionResult;
      try {
        result = runDirectCommand(parsed.commandName, parsed.forwardedArgs || []);
      } catch (error) {
        traceHarness('direct-command-error', { commandName: parsed.commandName, args: parsed.forwardedArgs || [], message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.statusCode;
      return;
    }
    case 'internal-shell': {
      assert(parsed.shellName);
      let result: CommandExecutionResult;
      try {
        result = executeShellProxy(parsed.shellName, parsed.forwardedArgs || []);
      } catch (error) {
        traceHarness('shell-proxy-error', { shellName: parsed.shellName, forwardedArgs: parsed.forwardedArgs || [], message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.statusCode;
      return;
    }
    case 'run':
      await runHarness(parsed.args!);
      return;
    default:
      throw new Error('unreachable');
  }
}

export function buildWindowsHarnessArgs(
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  packageRoot = getPackageRoot(),
): string[] {
  const configuredEnvOverrides = readConfiguredEnvOverrides(env.CODEX_HOME);
  const mergedEnv = {
    ...configuredEnvOverrides,
    ...env,
  };
  const sparkModel = mergedEnv[EXPLORE_SPARK_MODEL_ENV]?.trim()
    || getEnvConfiguredSparkDefaultModel(mergedEnv, mergedEnv.CODEX_HOME)
    || getSparkDefaultModel(mergedEnv.CODEX_HOME)
    || DEFAULT_SPARK_MODEL;
  const instructionsFile = mergedEnv[EXPLORE_INSTRUCTIONS_FILE_ENV]?.trim()
    || join(packageRoot, 'templates', 'model-instructions', 'explore-lightweight-AGENTS.md');
  const fallbackModel = getEnvConfiguredStandardDefaultModel(mergedEnv, mergedEnv.CODEX_HOME)
    || getStandardDefaultModel(mergedEnv.CODEX_HOME)
    || DEFAULT_STANDARD_MODEL;
  return [
    '--cwd', cwd,
    '--prompt', prompt,
    '--prompt-file', promptSurfaceSkillPath(join(packageRoot, 'skills'), 'explore-harness'),
    '--instructions-file', instructionsFile,
    '--model-spark', sparkModel,
    '--model-fallback', fallbackModel,
  ];
}
