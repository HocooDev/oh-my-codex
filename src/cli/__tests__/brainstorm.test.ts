import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BRAINSTORM_HELP,
	parseBrainstormArgs,
	parseBrainstormStatusArgs,
} from "../brainstorm.js";
import { writeBrainstormArtifact } from "../brainstorm-intake.js";

function runOmx(
	cwd: string,
	argv: string[],
	envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	const omxBin = join(repoRoot, "dist", "cli", "omx.js");
	const result = spawnSync(process.execPath, [omxBin, ...argv], {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			OMX_AUTO_UPDATE: "0",
			OMX_NOTIFY_FALLBACK: "0",
			OMX_HOOK_DERIVED_SIGNALS: "0",
			...envOverrides,
		},
	});
	return {
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		error: result.error?.message,
	};
}

async function initRepo(): Promise<string> {
	const raw = await mkdtemp(join(tmpdir(), "omx-brainstorm-cli-test-"));
	const cwd = realpathSync(raw);
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Test User"], {
		cwd,
		stdio: "ignore",
	});
	await writeFile(join(cwd, "README.md"), "hello\n", "utf-8");
	execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
	return cwd;
}

describe("brainstorm CLI parsing", () => {
	it("treats bare brainstorm as guided init and init as an alias", () => {
		assert.deepEqual(parseBrainstormArgs([]), { guided: true });

		const init = parseBrainstormArgs(["init", "--idea", "Review search UX"]);
		assert.equal(init.guided, true);
		assert.deepEqual(init.initArgs, ["--idea", "Review search UX"]);
		assert.equal(init.seedArgs?.idea, "Review search UX");
	});

	it("parses status selectors and json output flags", () => {
		assert.deepEqual(parseBrainstormArgs(["status", "--latest"]), {
			status: true,
			statusArgs: ["--latest"],
		});
		assert.deepEqual(parseBrainstormStatusArgs(["--latest", "--json"]), {
			slug: null,
			latest: true,
			json: true,
		});
		assert.deepEqual(parseBrainstormStatusArgs(["--slug", "search-ux"]), {
			slug: "search-ux",
			latest: false,
			json: false,
		});
		assert.deepEqual(parseBrainstormStatusArgs(["--help"]), {
			slug: null,
			latest: false,
			json: false,
			help: true,
		});
		assert.throws(
			() => parseBrainstormStatusArgs(["--slug", "search-ux", "--latest"]),
			/either --slug <slug> or --latest/i,
		);
		assert.throws(
			() => parseBrainstormStatusArgs(["--slug", "--json"]),
			/Missing value for --slug/i,
		);
	});

	it("keeps dedicated local help text", () => {
		assert.match(
			BRAINSTORM_HELP,
			/omx brainstorm - Guided brainstorm artifact runtime/i,
		);
		assert.match(BRAINSTORM_HELP, /does not auto-launch/i);
	});
});

describe("brainstorm CLI surface", () => {
	it("documents brainstorm in top-level help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-brainstorm-top-help-"));
		try {
			const result = runOmx(cwd, ["--help"]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(
				result.stdout,
				/omx brainstorm\s+Guided brainstorm artifact runtime/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("routes brainstorm --help to local help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-brainstorm-local-help-"));
		try {
			const result = runOmx(cwd, ["brainstorm", "--help"]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(
				result.stdout,
				/omx brainstorm - Guided brainstorm artifact runtime/i,
			);
			assert.match(result.stdout, /does not auto-launch/i);
			assert.doesNotMatch(
				result.stdout,
				/oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("routes brainstorm status --help to local help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-brainstorm-status-help-"));
		try {
			const result = runOmx(cwd, ["brainstorm", "status", "--help"]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(
				result.stdout,
				/omx brainstorm - Guided brainstorm artifact runtime/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("reads brainstorm status by slug and latest without launching downstream workflows", async () => {
		const cwd = await initRepo();
		try {
			const artifact = await writeBrainstormArtifact({
				repoRoot: cwd,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "approved_for_ralplan",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});
			await mkdir(join(cwd, ".omx", "state"), { recursive: true });
			await writeFile(
				join(cwd, ".omx", "state", "brainstorm-state.json"),
				JSON.stringify(
					{
						active: false,
						mode: "brainstorm",
						current_phase: "completed",
						completed_at: "2026-05-08T01:02:04.000Z",
						slug: "search-ux",
						brainstorm_artifact_path: artifact.path,
						approval_state: "approved_for_ralplan",
						recommended_next_skill: "ralplan",
						selected_next_skill: "ralplan",
						advisor_runs: {
							claude: {
								enabled: true,
								status: "failed",
								artifactPath: null,
								exitCode: 7,
								summary: "Provider command failed (exit 7): auth missing",
								error: "auth missing",
							},
							gemini: {
								enabled: false,
								status: "skipped",
								artifactPath: null,
								exitCode: null,
								summary: "Advisor not requested.",
								error: null,
							},
						},
					},
					null,
					2,
				),
				"utf-8",
			);

			const bySlug = runOmx(cwd, [
				"brainstorm",
				"status",
				"--slug",
				"search-ux",
				"--json",
			]);
			assert.equal(bySlug.status, 0, bySlug.stderr || bySlug.stdout);
			const parsedBySlug = JSON.parse(bySlug.stdout);
			assert.equal(parsedBySlug.artifact.slug, "search-ux");
			assert.equal(parsedBySlug.artifact.approvalState, "approved_for_ralplan");
			assert.equal(parsedBySlug.state.selected_next_skill, "ralplan");
			assert.equal(parsedBySlug.state.advisor_runs.claude.status, "failed");

			const latest = runOmx(cwd, ["brainstorm", "status", "--latest"]);
			assert.equal(latest.status, 0, latest.stderr || latest.stdout);
			assert.match(latest.stdout, /Brainstorm status: approved_for_ralplan/);
			assert.match(latest.stdout, /Advisor claude: failed/);
			assert.equal(
				existsSync(join(cwd, ".omx", "state", "deep-interview-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(cwd, ".omx", "state", "ralplan-state.json")),
				false,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("seeds a draft artifact non-interactively when --idea is provided", async () => {
		const cwd = await initRepo();
		try {
			const result = runOmx(cwd, [
				"brainstorm",
				"init",
				"--idea",
				"Seed a draft from CI",
				"--slug",
				"seed-ci",
				"--lang",
				"en",
			]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /Approval state: draft/);

			const state = JSON.parse(
				await readFile(
					join(cwd, ".omx", "state", "brainstorm-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.equal(state.current_phase, "draft_saved");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
