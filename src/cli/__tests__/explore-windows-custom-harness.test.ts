import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseJsonFile(content: string): unknown {
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

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
    env: { ...process.env, CODEX_HOME: '', ...envOverrides },
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function repoRootFromTestFile(): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return join(testDir, '..', '..', '..');
}

async function writeWindowsCodexStub(
  wd: string,
  capturePath: string,
): Promise<string> {
  const stubPs1 = join(wd, 'codex-stub.ps1');
  await writeFile(
    stubPs1,
    `
$cliArgs = @($args)
$outputIndex = [Array]::IndexOf($cliArgs, '-o')
$modelIndex = [Array]::IndexOf($cliArgs, '-m')
$outputPath = if ($outputIndex -ge 0) { $cliArgs[$outputIndex + 1] } else { '' }
$model = if ($modelIndex -ge 0) { $cliArgs[$modelIndex + 1] } else { '' }
$capturePath = $env:CAPTURE_PATH
if ($capturePath) {
  $payload = @{ args = $cliArgs; model = $model } | ConvertTo-Json -Depth 4
  Set-Content -LiteralPath $capturePath -Value $payload -Encoding utf8
}
if ($env:FAIL_SPARK_MODEL -and $model -eq $env:FAIL_SPARK_MODEL) {
  [Console]::Error.Write($env:FAIL_SPARK_STDERR)
  exit 17
}
if (-not $outputPath) {
  [Console]::Error.Write('missing output path')
  exit 1
}
Set-Content -LiteralPath $outputPath -Value "# Answer\`n- model: $model" -Encoding utf8
`.trim(),
    'utf-8',
  );
  await chmod(stubPs1, 0o755);
  return stubPs1;
}

describe('Windows custom explore harness', () => {
  it('executes through OMX_EXPLORE_BIN and preserves markdown output', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-harness-'));
    try {
      const capturePath = join(wd, 'capture.json');
      const codexStub = await writeWindowsCodexStub(wd, capturePath);
      const result = runOmx(wd, ['explore', '--prompt', 'find auth'], {
        OMX_EXPLORE_BIN: 'src/scripts/explore-windows-harness.ps1',
        OMX_EXPLORE_CODEX_BIN: codexStub,
        CAPTURE_PATH: capturePath,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /# Answer/);
      assert.match(result.stdout, /model:/);
      assert.equal(result.stderr, '');
      const captured = parseJsonFile(await readFile(capturePath, 'utf-8')) as { args: string[]; model: string };
      assert.ok(captured.args.includes('--skip-git-repo-check'));
      assert.ok(captured.args.some((value) => value.includes('find auth')));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports prompt-file input through the Windows harness', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-prompt-file-'));
    try {
      const capturePath = join(wd, 'capture.json');
      const promptFile = join(wd, 'prompt.md');
      await writeFile(promptFile, 'find prompt-file support\n', 'utf-8');
      const codexStub = await writeWindowsCodexStub(wd, capturePath);
      const result = runOmx(wd, ['explore', '--prompt-file', promptFile], {
        OMX_EXPLORE_BIN: 'src/scripts/explore-windows-harness.ps1',
        OMX_EXPLORE_CODEX_BIN: codexStub,
        CAPTURE_PATH: capturePath,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const captured = parseJsonFile(await readFile(capturePath, 'utf-8')) as { args: string[] };
      assert.ok(captured.args.some((value) => value.includes('find prompt-file support')));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves fallback stderr/stdout semantics through the Windows harness', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-fallback-'));
    try {
      const capturePath = join(wd, 'capture.json');
      const codexStub = await writeWindowsCodexStub(wd, capturePath);
      const result = runOmx(wd, ['explore', '--prompt', 'find auth'], {
        OMX_EXPLORE_BIN: 'src/scripts/explore-windows-harness.ps1',
        OMX_EXPLORE_CODEX_BIN: codexStub,
        CAPTURE_PATH: capturePath,
        OMX_EXPLORE_SPARK_MODEL: 'spark-test-model',
        FAIL_SPARK_MODEL: 'spark-test-model',
        FAIL_SPARK_STDERR: 'spark backend unavailable; retry with fallback',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /fallback-attempt=model from=`spark-test-model`/);
      assert.match(result.stderr, /spark stderr: spark backend unavailable; retry with fallback/);
      assert.match(result.stdout, /## OMX Explore fallback/);
      assert.match(result.stdout, /- model: /);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back from sparkshell to the Windows harness when sparkshell is unavailable', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-sparkshell-fallback-'));
    try {
      const capturePath = join(wd, 'capture.json');
      const codexStub = await writeWindowsCodexStub(wd, capturePath);
      const result = runOmx(wd, ['explore', '--prompt', 'git log --oneline'], {
        OMX_EXPLORE_BIN: 'src/scripts/explore-windows-harness.ps1',
        OMX_EXPLORE_CODEX_BIN: codexStub,
        CAPTURE_PATH: capturePath,
        OMX_SPARKSHELL_BIN: join(wd, 'missing-sparkshell.cmd'),
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /sparkshell backend unavailable/);
      assert.match(result.stderr, /Falling back to the explore harness/);
      assert.match(result.stdout, /# Answer/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('exposes a probe mode through the Windows wrapper', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-probe-'));
    try {
      const repoRoot = repoRootFromTestFile();
      const wrapperPath = join(repoRoot, 'src', 'scripts', 'explore-windows-harness.ps1');
      assert.equal(existsSync(wrapperPath), true);
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '--probe', 'entrypoint'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout || '', /"mode": "entrypoint"/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports internal direct command execution for pwd and printf', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-direct-'));
    try {
      const repoRoot = repoRootFromTestFile();
      const scriptPath = join(repoRoot, 'dist', 'scripts', 'explore-windows-harness.js');
      const pwdResult = spawnSync(process.execPath, [scriptPath, '--internal-direct', 'pwd'], {
        cwd: wd,
        encoding: 'utf-8',
        env: { ...process.env, OMX_EXPLORE_ROOT: wd },
        windowsHide: true,
      });
      assert.equal(pwdResult.status, 0, pwdResult.stderr || pwdResult.stdout);
      assert.match(pwdResult.stdout || '', new RegExp(wd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const printfResult = spawnSync(process.execPath, [scriptPath, '--internal-direct', 'printf', '%s\\n', 'hello'], {
        cwd: wd,
        encoding: 'utf-8',
        env: { ...process.env, OMX_EXPLORE_ROOT: wd },
        windowsHide: true,
      });
      assert.equal(printfResult.status, 0, printfResult.stderr || printfResult.stdout);
      assert.equal(printfResult.stdout, 'hello\n');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('supports internal shell proxy execution and fail-closed rejection', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-shell-proxy-'));
    try {
      const repoRoot = repoRootFromTestFile();
      const scriptPath = join(repoRoot, 'dist', 'scripts', 'explore-windows-harness.js');
      const okResult = spawnSync(process.execPath, [scriptPath, '--internal-shell', 'powershell', '-NoLogo', '-NoProfile', '-Command', 'pwd'], {
        cwd: wd,
        encoding: 'utf-8',
        env: { ...process.env, OMX_EXPLORE_ROOT: wd },
        windowsHide: true,
      });
      assert.equal(okResult.status, 0, okResult.stderr || okResult.stdout);
      assert.match(okResult.stdout || '', new RegExp(wd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const blockedResult = spawnSync(process.execPath, [scriptPath, '--internal-shell', 'powershell', '-NoLogo', '-NoProfile', '-Command', 'git status'], {
        cwd: wd,
        encoding: 'utf-8',
        env: { ...process.env, OMX_EXPLORE_ROOT: wd },
        windowsHide: true,
      });
      assert.equal(blockedResult.status, 1);
      assert.match(blockedResult.stderr || '', /not on the omx explore allowlist/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('runs host rg without inheriting RIPGREP_CONFIG_PATH', async () => {
    if (process.platform !== 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-win-rg-config-'));
    try {
      const repoRoot = repoRootFromTestFile();
      const scriptPath = join(repoRoot, 'dist', 'scripts', 'explore-windows-harness.js');
      const targetFile = join(wd, 'sample.txt');
      const badConfig = join(wd, 'ripgrep-config.txt');
      await writeFile(targetFile, 'needle-value\n', 'utf-8');
      await writeFile(badConfig, '--this-option-does-not-exist\n', 'utf-8');

      const result = spawnSync(process.execPath, [scriptPath, '--internal-direct', 'rg', 'needle-value', targetFile], {
        cwd: wd,
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_EXPLORE_ROOT: wd,
          OMX_EXPLORE_HOST_PATH: process.env.PATH || '',
          RIPGREP_CONFIG_PATH: badConfig,
        },
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout || '', /needle-value/);
      assert.doesNotMatch(result.stderr || '', /does-not-exist/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
