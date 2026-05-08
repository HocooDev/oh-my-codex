import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CLAUDE_SKIP_PERMISSIONS_FLAG } from './constants.js';

export const PROVIDER_ADVISORS = ['claude', 'gemini'] as const;
export type ProviderAdvisorName = (typeof PROVIDER_ADVISORS)[number];
export type ProviderAdvisorRunStatus = 'succeeded' | 'failed';

const PROVIDER_BINARIES: Record<ProviderAdvisorName, string> = {
  claude: 'claude',
  gemini: 'gemini',
};
const PROVIDER_BINARY_ENV_PREFIX = 'OMX_ASK_PROVIDER_';

const ISSUE_WORK_PROMPT_PATTERNS = [
  /\bgh\s+issue\b/i,
  /\b(?:fix|work on|work|investigate|implement|triage|debug|review|handle)\s+issue\s*#?\d+\b/i,
  /\bissue\s*#\d+\b/i,
];

export interface ExecuteProviderAdvisorInput {
  provider: ProviderAdvisorName;
  prompt: string;
  originalTask?: string;
  cwd?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderAdvisorExecutionResult {
  provider: ProviderAdvisorName;
  binary: string;
  prompt: string;
  originalTask: string;
  artifactPath: string;
  createdAt: string;
  status: ProviderAdvisorRunStatus;
  exitCode: number;
  rawOutput: string;
  summary: string;
  actionItems: string[];
  errorMessage: string | null;
}

export interface ProviderAdvisorDoctorProbe {
  configured: string | null;
  resolved: string | null;
  overridden: boolean;
  exists: boolean | null;
  ready: boolean;
  exitCode: number | null;
  summary: string;
  error: string | null;
  verifyCommand: string | null;
}

export interface ProviderAdvisorDoctorResult {
  provider: ProviderAdvisorName;
  binary: ProviderAdvisorDoctorProbe;
  script: ProviderAdvisorDoctorProbe;
  ready: boolean;
  summary: string;
  nextSteps: string[];
}

export interface ProviderAdvisorDoctorSummary {
  providers: Record<ProviderAdvisorName, ProviderAdvisorDoctorResult>;
  summary: string;
  nextSteps: string[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

function timestampToken(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function buildSummary(exitCode: number, output: string): string {
  const firstLine = firstNonEmptyLine(output);
  if (exitCode === 0) {
    return firstLine
      ? `Provider response excerpt: ${firstLine}`
      : 'Provider completed successfully. Review the raw output for details.';
  }

  return firstLine
    ? `Provider command failed (exit ${exitCode}): ${firstLine}`
    : `Provider command failed with exit code ${exitCode}.`;
}

function buildActionItems(exitCode: number): string[] {
  if (exitCode === 0) {
    return [
      'Review the response and extract decisions you want to apply.',
      'Capture follow-up implementation tasks if needed.',
    ];
  }

  return [
    'Inspect the raw output error details.',
    'Fix CLI/auth/environment issues and rerun the command.',
  ];
}

function shouldUseClaudeIssuePermissionsBypass(
  provider: ProviderAdvisorName,
  prompt: string,
): boolean {
  if (provider !== 'claude') return false;
  const trimmed = prompt.trim();
  if (trimmed === '') return false;
  return ISSUE_WORK_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === 'number' && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }
  return 1;
}

function renderRawOutput(stdout: string, stderr: string, errorMessage: string | null): string {
  return [stdout, stderr, errorMessage].filter(Boolean).join(stdout && (stderr || errorMessage) ? '\n\n' : '\n').trim();
}

export function resolveProviderBinary(provider: ProviderAdvisorName, env: NodeJS.ProcessEnv): string {
  const override = env[`${PROVIDER_BINARY_ENV_PREFIX}${provider.toUpperCase()}_BIN`]?.trim();
  return override || PROVIDER_BINARIES[provider];
}

export function resolveProviderScript(provider: ProviderAdvisorName, env: NodeJS.ProcessEnv): string | null {
  return env[`${PROVIDER_BINARY_ENV_PREFIX}${provider.toUpperCase()}_SCRIPT`]?.trim() || null;
}

function resolveProviderScriptPath(script: string, cwd: string): string {
  return isAbsolute(script) ? script : resolve(cwd, script);
}

function launchArgsForProvider(
  provider: ProviderAdvisorName,
  prompt: string,
  originalTask: string,
): string[] {
  return shouldUseClaudeIssuePermissionsBypass(provider, originalTask)
    ? [CLAUDE_SKIP_PERMISSIONS_FLAG, '-p', prompt]
    : ['-p', prompt];
}

async function runProviderProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  binaryLabel: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string; errorMessage: string | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let errorMessage: string | null = null;

    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        const verify = `${input.binaryLabel} --version`;
        errorMessage = [
          `[ask-${input.binaryLabel}] Missing required local CLI binary: ${input.binaryLabel}`,
          `[ask-${input.binaryLabel}] Install/configure ${input.binaryLabel} CLI, then verify with: ${verify}`,
        ].join('\n');
      } else {
        errorMessage = `[ask-${input.binaryLabel}] ${error.message}`;
      }
    });
    child.on('close', (code, signal) => {
      resolve({
        exitCode: typeof code === 'number' ? code : resolveSignalExitCode(signal),
        stdout,
        stderr,
        errorMessage,
      });
    });
  });
}

async function verifyBinary(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderAdvisorDoctorProbe> {
  const result = await runProviderProcess({
    command: binary,
    args: ['--version'],
    cwd,
    env,
    binaryLabel: binary,
  });
  const exitCode = result.errorMessage ? 1 : result.exitCode;
  const rawOutput = renderRawOutput(result.stdout, result.stderr, result.errorMessage);
  const ready = exitCode === 0;
  return {
    configured: binary,
    resolved: binary,
    overridden: binary !== PROVIDER_BINARIES.claude && binary !== PROVIDER_BINARIES.gemini,
    exists: null,
    ready,
    exitCode,
    summary: ready
      ? firstNonEmptyLine(rawOutput) || `${binary} responded to --version.`
      : buildSummary(exitCode, rawOutput),
    error: result.errorMessage,
    verifyCommand: `${binary} --version`,
  };
}

function probeScript(
  provider: ProviderAdvisorName,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ProviderAdvisorDoctorProbe {
  const script = resolveProviderScript(provider, env);
  if (!script) {
    return {
      configured: null,
      resolved: null,
      overridden: false,
      exists: null,
      ready: false,
      exitCode: null,
      summary: 'No script override configured.',
      error: null,
      verifyCommand: null,
    };
  }

  const resolved = resolveProviderScriptPath(script, cwd);
  const exists = existsSync(resolved);
  return {
    configured: script,
    resolved,
    overridden: true,
    exists,
    ready: exists,
    exitCode: exists ? 0 : null,
    summary: exists
      ? `Script override active: ${script}`
      : `Script override not found: ${script}`,
    error: exists ? null : `Missing script override: ${resolved}`,
    verifyCommand: exists ? `node ${script}` : null,
  };
}

function binaryOverrideActive(
  provider: ProviderAdvisorName,
  env: NodeJS.ProcessEnv,
): boolean {
  const override = env[`${PROVIDER_BINARY_ENV_PREFIX}${provider.toUpperCase()}_BIN`]?.trim();
  return Boolean(override);
}

export async function diagnoseProviderAdvisor(input: {
  provider: ProviderAdvisorName;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderAdvisorDoctorResult> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const binary = resolveProviderBinary(input.provider, env);
  const binaryProbe = await verifyBinary(binary, cwd, env);
  binaryProbe.overridden = binaryOverrideActive(input.provider, env);
  const scriptProbe = probeScript(input.provider, cwd, env);

  const ready = scriptProbe.overridden ? scriptProbe.ready : binaryProbe.ready;
  const nextSteps: string[] = [];
  if (scriptProbe.overridden) {
    if (!scriptProbe.ready) {
      nextSteps.push(`Fix or remove ${input.provider} script override: ${scriptProbe.configured}`);
    } else {
      nextSteps.push(`Review the ${input.provider} script override at ${scriptProbe.resolved}`);
    }
  }
  if (!binaryProbe.ready) {
    nextSteps.push(`Run ${binaryProbe.verifyCommand ?? `${binary} --version`} and fix the reported CLI/auth issue.`);
  }
  nextSteps.push(`Rerun: omx brainstorm doctor${ready ? ' --json' : ''}`.trim());

  const summary = scriptProbe.overridden
    ? scriptProbe.ready
      ? binaryProbe.ready
        ? 'Script override and provider binary are both available.'
        : 'Script override is available, but the provider binary check failed.'
      : 'Script override is configured, but the file is missing.'
    : binaryProbe.ready
      ? 'Provider binary is ready.'
      : 'Provider binary is not executable yet.';

  return {
    provider: input.provider,
    binary: binaryProbe,
    script: scriptProbe,
    ready,
    summary,
    nextSteps: [...new Set(nextSteps)],
  };
}

export async function diagnoseAllProviderAdvisors(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ProviderAdvisorDoctorSummary> {
  const providers = Object.fromEntries(
    await Promise.all(
      PROVIDER_ADVISORS.map(async (provider) => [
        provider,
        await diagnoseProviderAdvisor({ provider, cwd: input.cwd, env: input.env }),
      ] as const),
    ),
  ) as Record<ProviderAdvisorName, ProviderAdvisorDoctorResult>;

  const readyCount = Object.values(providers).filter((provider) => provider.ready).length;
  const nextSteps = [...new Set(Object.values(providers).flatMap((provider) => provider.nextSteps))];
  return {
    providers,
    summary: `${readyCount}/${PROVIDER_ADVISORS.length} brainstorm advisor providers are ready on this machine.`,
    nextSteps,
  };
}

async function writeProviderAdvisorArtifact(result: {
  provider: ProviderAdvisorName;
  originalTask: string;
  prompt: string;
  rawOutput: string;
  exitCode: number;
  errorMessage: string | null;
  cwd: string;
  now: Date;
}): Promise<string> {
  const artifactDir = join(result.cwd, '.omx', 'artifacts');
  const artifactPath = join(
    artifactDir,
    `ask-${result.provider}-${slugify(result.originalTask)}-${timestampToken(result.now)}.md`,
  );
  const summary = buildSummary(result.exitCode, result.rawOutput);
  const actionItems = buildActionItems(result.exitCode);
  const createdAt = result.now.toISOString();

  const body = [
    `# ${result.provider} advisor artifact`,
    '',
    `- Provider: ${result.provider}`,
    `- Exit code: ${result.exitCode}`,
    `- Status: ${result.exitCode === 0 ? 'succeeded' : 'failed'}`,
    `- Created at: ${createdAt}`,
    `- Error: ${result.errorMessage ?? 'none'}`,
    '',
    '## Original task',
    '',
    result.originalTask,
    '',
    '## Final prompt',
    '',
    result.prompt,
    '',
    '## Raw output',
    '',
    '```text',
    result.rawOutput || '(no output)',
    '```',
    '',
    '## Concise summary',
    '',
    summary,
    '',
    '## Action items',
    '',
    ...actionItems.map((item) => `- ${item}`),
    '',
  ].join('\n');

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, body, 'utf8');
  return artifactPath;
}

export async function executeProviderAdvisor(
  input: ExecuteProviderAdvisorInput,
): Promise<ProviderAdvisorExecutionResult> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const prompt = input.prompt.trim();
  const originalTask = input.originalTask?.trim() || prompt;
  const now = input.now ?? new Date();
  const binary = resolveProviderBinary(input.provider, env);
  const script = resolveProviderScript(input.provider, env);
  const command = script ? process.execPath : binary;
  const prefixArgs = script ? [script] : [];
  const run = await runProviderProcess({
    command,
    args: [...prefixArgs, ...launchArgsForProvider(input.provider, prompt, originalTask)],
    cwd,
    env,
    binaryLabel: binary,
  });
  const exitCode = run.errorMessage ? 1 : run.exitCode;
  const stdout = run.stdout;
  const stderr = run.stderr;
  const errorMessage = run.errorMessage;

  const rawOutput = renderRawOutput(stdout, stderr, errorMessage);
  const artifactPath = await writeProviderAdvisorArtifact({
    provider: input.provider,
    originalTask,
    prompt,
    rawOutput,
    exitCode,
    errorMessage,
    cwd,
    now,
  });

  return {
    provider: input.provider,
    binary,
    prompt,
    originalTask,
    artifactPath,
    createdAt: now.toISOString(),
    status: exitCode === 0 ? 'succeeded' : 'failed',
    exitCode,
    rawOutput,
    summary: buildSummary(exitCode, rawOutput),
    actionItems: buildActionItems(exitCode),
    errorMessage,
  };
}
