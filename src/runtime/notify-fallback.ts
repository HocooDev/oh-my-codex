import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getPackageRoot } from "../utils/package.js";
import { isMsysOrGitBash } from "../team/tmux-session.js";

export interface NotifyFallbackPidFileRecord {
  pid: number;
  cwd?: string;
  session_id?: string;
  parent_pid?: number;
  started_at?: string;
  owner_token?: string;
}

interface NotifyFallbackStateRecord {
  pid?: number;
  cwd?: string;
  parent_pid?: number;
  owner_token?: string;
}

interface NotifyFallbackOwner {
  cwd: string;
  ownerPid: number;
  sessionId?: string;
}

export function notifyFallbackPidPath(cwd: string): string {
  return join(cwd, ".omx", "state", "notify-fallback.pid");
}

function notifyFallbackStatePath(cwd: string): string {
  return join(cwd, ".omx", "state", "notify-fallback-state.json");
}

export function shouldEnableNotifyFallbackWatcher(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  void platform;
  return String(env.OMX_NOTIFY_FALLBACK ?? "").trim() !== "0";
}

export function buildNotifyFallbackWatcherEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    codexHomeOverride?: string;
    enableAuthority?: boolean;
    sessionId?: string;
  } = {},
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
  };
  delete nextEnv.TMUX;
  delete nextEnv.TMUX_PANE;

  return {
    ...nextEnv,
    ...(options.codexHomeOverride ? { CODEX_HOME: options.codexHomeOverride } : {}),
    ...(options.sessionId ? { OMX_SESSION_ID: options.sessionId } : {}),
    OMX_HUD_AUTHORITY: options.enableAuthority ? "1" : "0",
  };
}

function shouldDetachBackgroundHelper(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  void env;
  void platform;
  return true;
}

type BackgroundHelperLaunchMode =
  | "direct-detached"
  | "windows-msys-bootstrap";

function resolveBackgroundHelperLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BackgroundHelperLaunchMode {
  return platform === "win32" && isMsysOrGitBash(env, platform)
    ? "windows-msys-bootstrap"
    : "direct-detached";
}

function buildWindowsMsysBackgroundHelperBootstrapScript(
  helperArgs: readonly string[],
  cwd: string,
): string {
  const helperArgsLiteral = JSON.stringify(helperArgs);
  const cwdLiteral = JSON.stringify(cwd);
  return [
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, ${helperArgsLiteral}, { cwd: ${cwdLiteral}, detached: true, stdio: 'ignore', windowsHide: true, env: process.env });`,
    "if (!child.pid) process.exit(1);",
    "process.stdout.write(String(child.pid));",
    "child.unref();",
  ].join("");
}

async function launchBackgroundHelper(
  helperArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number | undefined> {
  const launchMode = resolveBackgroundHelperLaunchMode(
    options.env,
    process.platform,
  );

  if (launchMode === "windows-msys-bootstrap") {
    const bootstrap = spawnSync(
      process.execPath,
      [
        "-e",
        buildWindowsMsysBackgroundHelperBootstrapScript(
          helperArgs,
          options.cwd,
        ),
      ],
      {
        cwd: options.cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: options.env,
      },
    );

    if (bootstrap.error) {
      throw bootstrap.error;
    }

    if (bootstrap.status !== 0) {
      const detail = (bootstrap.stderr || bootstrap.stdout || "").trim();
      throw new Error(
        detail || `background helper bootstrap exited ${bootstrap.status}`,
      );
    }

    const helperPid = Number.parseInt((bootstrap.stdout || "").trim(), 10);
    return Number.isFinite(helperPid) && helperPid > 0
      ? helperPid
      : undefined;
  }

  const child = spawn(process.execPath, helperArgs, {
    cwd: options.cwd,
    detached: shouldDetachBackgroundHelper(options.env, process.platform),
    stdio: "ignore",
    windowsHide: true,
    env: options.env,
  });
  child.unref();
  return child.pid;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null
      && typeof error === "object"
      && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseWatcherPidRecord(content: string): NotifyFallbackPidFileRecord | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsedRaw = JSON.parse(trimmed) as unknown;
    if (typeof parsedRaw === "number" && Number.isFinite(parsedRaw) && parsedRaw > 0) {
      return { pid: parsedRaw };
    }
    const parsed = parsedRaw as Partial<NotifyFallbackPidFileRecord>;
    if (
      typeof parsed.pid === "number"
      && Number.isFinite(parsed.pid)
      && parsed.pid > 0
    ) {
      return {
        pid: parsed.pid,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
        session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        parent_pid: typeof parsed.parent_pid === "number" ? parsed.parent_pid : undefined,
        started_at: typeof parsed.started_at === "string" ? parsed.started_at : undefined,
        owner_token: typeof parsed.owner_token === "string" ? parsed.owner_token : undefined,
      };
    }
  } catch {
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isFinite(pid) && pid > 0) {
      return { pid };
    }
  }
  return null;
}

async function readWatcherPidRecord(
  pidPath: string,
): Promise<NotifyFallbackPidFileRecord | null> {
  if (!existsSync(pidPath)) return null;
  try {
    return parseWatcherPidRecord(await readFile(pidPath, "utf-8"));
  } catch {
    return null;
  }
}

async function readWatcherStateRecord(
  cwd: string,
): Promise<NotifyFallbackStateRecord | null> {
  const statePath = notifyFallbackStatePath(cwd);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8")) as Partial<NotifyFallbackStateRecord>;
    return {
      pid:
        typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      parent_pid:
        typeof parsed.parent_pid === "number" &&
        Number.isFinite(parsed.parent_pid) &&
        parsed.parent_pid > 0
          ? parsed.parent_pid
          : undefined,
      owner_token:
        typeof parsed.owner_token === "string" ? parsed.owner_token : undefined,
    };
  } catch {
    return null;
  }
}

export async function reapStaleNotifyFallbackWatcher(
  pidPath: string,
  deps: {
    exists?: (path: string) => boolean;
    readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
    tryKillPid?: (pid: number, signal?: NodeJS.Signals) => boolean;
    isWatcherProcess?: (pid: number) => boolean;
    hasErrnoCode?: (error: unknown, code: string) => boolean;
    warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
  } = {},
  owner?: NotifyFallbackOwner,
): Promise<boolean> {
  const exists = deps.exists ?? existsSync;
  if (!exists(pidPath)) return false;

  const readFileImpl = deps.readFile ?? readFile;
  const tryKillPidImpl = deps.tryKillPid ?? tryKillPid;
  const hasErrnoCodeImpl = deps.hasErrnoCode ?? hasErrnoCode;
  const warn = deps.warn ?? console.warn;

  try {
    const record = parseWatcherPidRecord(await readFileImpl(pidPath, "utf-8"));
    if (!record?.pid) return false;

    if (deps.isWatcherProcess && !deps.isWatcherProcess(record.pid)) {
      return false;
    }

    if (owner && isPidAlive(record.pid)) {
      const expectedSessionId = owner.sessionId?.trim() ?? "";
      const actualSessionId = record.session_id?.trim() ?? "";
      const statePath = join(dirname(pidPath), "notify-fallback-state.json");
      let state: NotifyFallbackStateRecord | null = null;
      if (exists(statePath)) {
        try {
          const parsed = JSON.parse(
            await readFileImpl(statePath, "utf-8"),
          ) as Partial<NotifyFallbackStateRecord>;
          state = {
            pid:
              typeof parsed.pid === "number" &&
              Number.isFinite(parsed.pid) &&
              parsed.pid > 0
                ? parsed.pid
                : undefined,
            cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
            parent_pid:
              typeof parsed.parent_pid === "number" &&
              Number.isFinite(parsed.parent_pid) &&
              parsed.parent_pid > 0
                ? parsed.parent_pid
                : undefined,
            owner_token:
              typeof parsed.owner_token === "string"
                ? parsed.owner_token
                : undefined,
          };
        } catch {
          state = null;
        }
      }

      const owned =
        record.cwd === owner.cwd &&
        record.parent_pid === owner.ownerPid &&
        actualSessionId === expectedSessionId &&
        !!state &&
        state.pid === record.pid &&
        state.cwd === owner.cwd &&
        state.parent_pid === owner.ownerPid &&
        (
          !record.owner_token ||
          !state.owner_token ||
          state.owner_token === record.owner_token
        );

      if (!owned) {
        warn("[omx] warning: refusing to stop unowned notify fallback watcher", {
          path: pidPath,
          pid: record.pid,
          cwd: record.cwd,
          parent_pid: record.parent_pid,
          session_id: record.session_id,
        });
        return false;
      }
    }
    return tryKillPidImpl(record.pid, "SIGTERM");
  } catch (error: unknown) {
    if (!hasErrnoCodeImpl(error, "ESRCH")) {
      warn(
        "[omx] warning: failed to stop stale notify fallback watcher",
        {
          path: pidPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return false;
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}

function resolveDistScript(pkgRoot: string, scriptName: string): string {
  return join(pkgRoot, "dist", "scripts", scriptName);
}

export interface EnsureNotifyFallbackWatcherOptions {
  codexHomeOverride?: string;
  enableAuthority?: boolean;
  ownerPid?: number;
  sessionId?: string;
  pkgRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export async function ensureNotifyFallbackWatcher(
  cwd: string,
  options: EnsureNotifyFallbackWatcherOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const ownerPid = options.ownerPid ?? process.pid;
  if (!shouldEnableNotifyFallbackWatcher(env, platform)) return;

  const pidPath = notifyFallbackPidPath(cwd);
  const existingRecord = await readWatcherPidRecord(pidPath);
  const requestedSessionId = options.sessionId?.trim() ?? "";
  const existingSessionId = existingRecord?.session_id?.trim() ?? "";
  const existingState = await readWatcherStateRecord(cwd);
  const existingStateMatches =
    !existingState ||
    (
      existingState.pid === existingRecord?.pid &&
      existingState.cwd === cwd &&
      existingState.parent_pid === ownerPid &&
      (
        !existingState.owner_token ||
        existingState.owner_token === existingRecord?.owner_token
      )
    );
  if (
    existingRecord
    && isPidAlive(existingRecord.pid)
    && existingRecord.cwd === cwd
    && existingRecord.parent_pid === ownerPid
    && existingSessionId === requestedSessionId
    && existingStateMatches
  ) {
    return;
  }

  if (existingRecord?.pid && isPidAlive(existingRecord.pid)) {
    const reaped = await reapStaleNotifyFallbackWatcher(
      pidPath,
      {},
      { cwd, ownerPid, sessionId: options.sessionId },
    );
    if (!reaped) return;
  }

  const pkgRoot = options.pkgRoot ?? getPackageRoot();
  const watcherScript = resolveDistScript(pkgRoot, "notify-fallback-watcher.js");
  const notifyScript = resolveDistScript(pkgRoot, "notify-hook.js");
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;

  await mkdir(join(cwd, ".omx", "state"), { recursive: true }).catch(
    (error: unknown) => {
      console.warn(
        "[omx] warning: failed to create notify fallback watcher state directory",
        {
          cwd,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  );

  const watcherEnv = buildNotifyFallbackWatcherEnv(env, {
    codexHomeOverride: options.codexHomeOverride,
    enableAuthority: options.enableAuthority === true,
    sessionId: options.sessionId,
  });
  const ownerToken = `${ownerPid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  watcherEnv.OMX_NOTIFY_FALLBACK_OWNER_TOKEN = ownerToken;

  let watcherPid: number | undefined;
  try {
    watcherPid = await launchBackgroundHelper(
      [
        watcherScript,
        "--cwd",
        cwd,
        "--notify-script",
        notifyScript,
        "--pid-file",
        pidPath,
        "--parent-pid",
        String(ownerPid),
        ...(env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS
          ? [
            "--max-lifetime-ms",
            env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS,
          ]
          : []),
      ],
      {
        cwd,
        env: watcherEnv,
      },
    );
  } catch (error: unknown) {
    console.warn("[omx] warning: failed to launch notify fallback watcher", {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!watcherPid) return;

  const record: NotifyFallbackPidFileRecord = {
    pid: watcherPid,
    cwd,
    session_id: options.sessionId,
    parent_pid: ownerPid,
    started_at: new Date().toISOString(),
    owner_token: ownerToken,
  };
  await writeFile(pidPath, JSON.stringify(record, null, 2)).catch(
    (error: unknown) => {
      console.warn(
        "[omx] warning: failed to write notify fallback watcher pid file",
        {
          path: pidPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  );
}
