import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BRAINSTORM_HELP,
	parseBrainstormApproveArgs,
	parseBrainstormArgs,
	parseBrainstormDoctorArgs,
	parseBrainstormHistoryArgs,
	parseBrainstormListArgs,
	parseBrainstormResumeArgs,
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

	it("parses resume, list, and history flags", () => {
		assert.deepEqual(parseBrainstormArgs(["resume", "--slug", "search-ux"]), {
			resume: true,
			resumeArgs: ["--slug", "search-ux"],
		});
		assert.deepEqual(parseBrainstormResumeArgs(["--slug", "search-ux"]), {
			slug: "search-ux",
			lang: undefined,
			withClaude: false,
			withGemini: false,
			nonInteractive: false,
		});
		assert.deepEqual(
			parseBrainstormResumeArgs([
				"--slug",
				"search-ux",
				"--lang",
				"zh-CN",
				"--with-claude",
			]),
			{
				slug: "search-ux",
				lang: "zh-CN",
				withClaude: true,
				withGemini: false,
				nonInteractive: false,
			},
		);
		assert.deepEqual(
			parseBrainstormResumeArgs([
				"--slug",
				"search-ux",
				"--non-interactive",
			]),
			{
				slug: "search-ux",
				lang: undefined,
				withClaude: false,
				withGemini: false,
				nonInteractive: true,
			},
		);

		// approve subcommand
		assert.deepEqual(parseBrainstormArgs(["approve", "--slug", "search-ux"]), {
			approve: true,
			approveArgs: ["--slug", "search-ux"],
		});
		assert.deepEqual(parseBrainstormApproveArgs(["--slug", "search-ux"]), {
			slug: "search-ux",
			json: false,
		});
		assert.throws(
			() => parseBrainstormApproveArgs(["--json"]),
			/Missing required --slug/i,
		);
		assert.deepEqual(parseBrainstormListArgs(["--json"]), { json: true });
		assert.deepEqual(parseBrainstormDoctorArgs(["--json"]), { json: true });
		assert.deepEqual(
			parseBrainstormHistoryArgs(["--slug", "search-ux", "--json"]),
			{
				slug: "search-ux",
				json: true,
			},
		);
		assert.throws(
			() => parseBrainstormResumeArgs(["--latest"]),
			/not supported/i,
		);
		assert.throws(
			() => parseBrainstormHistoryArgs(["--json"]),
			/Missing required --slug/i,
		);
		assert.throws(
			() => parseBrainstormDoctorArgs(["--bogus"]),
			/Unknown brainstorm doctor flag/i,
		);
	});

	it("keeps dedicated local help text", () => {
		assert.match(
			BRAINSTORM_HELP,
			/omx brainstorm - Guided brainstorm artifact runtime/i,
		);
		assert.match(BRAINSTORM_HELP, /does not auto-launch/i);
		assert.match(BRAINSTORM_HELP, /omx brainstorm resume --slug/i);
		assert.match(BRAINSTORM_HELP, /omx brainstorm approve --slug/i);
		assert.match(BRAINSTORM_HELP, /omx brainstorm list \[--json\]/i);
		assert.match(BRAINSTORM_HELP, /omx brainstorm history --slug/i);
		assert.match(BRAINSTORM_HELP, /omx brainstorm doctor \[--json\]/i);
		assert.match(BRAINSTORM_HELP, /--non-interactive/i);
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

	it("runs brainstorm doctor with stable json output", async () => {
		const cwd = await initRepo();
		try {
			const scriptPath = join(cwd, "claude-doctor-stub.js");
			await writeFile(
				scriptPath,
				'console.log("claude stub");\n',
				"utf-8",
			);
			const result = runOmx(
				cwd,
				["brainstorm", "doctor", "--json"],
				{
					OMX_ASK_PROVIDER_CLAUDE_BIN: process.execPath,
					OMX_ASK_PROVIDER_CLAUDE_SCRIPT: scriptPath,
					OMX_ASK_PROVIDER_GEMINI_BIN: "definitely-missing-gemini-binary",
				},
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const parsed = JSON.parse(result.stdout) as {
				providers: Record<
					string,
					{
						ready: boolean;
						binary: { configured: string | null; ready: boolean };
						script: { configured: string | null; overridden: boolean; ready: boolean };
					}
				>;
				nextSteps: string[];
			};
			assert.equal(parsed.providers.claude.ready, true);
			assert.equal(parsed.providers.claude.binary.configured, process.execPath);
			assert.equal(parsed.providers.claude.script.overridden, true);
			assert.equal(parsed.providers.gemini.binary.ready, false);
			assert.ok(parsed.nextSteps.length > 0);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("lists and filters brainstorm artifact history with stable json output", async () => {
		const cwd = await initRepo();
		try {
			await writeBrainstormArtifact({
				repoRoot: cwd,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "approved_for_deep_interview",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});
			await writeBrainstormArtifact({
				repoRoot: cwd,
				idea: "Review auth UX",
				slug: "auth-ux",
				lang: "en",
				approvalState: "approved_for_deep_interview",
				now: new Date("2026-05-08T01:02:04.000Z"),
			});
			const latestSearch = await writeBrainstormArtifact({
				repoRoot: cwd,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "approved_for_ralplan",
				advisorFlags: { withClaude: true, withGemini: false },
				now: new Date("2026-05-08T01:02:05.000Z"),
			});

			const list = runOmx(cwd, ["brainstorm", "list", "--json"]);
			assert.equal(list.status, 0, list.stderr || list.stdout);
			const parsedList = JSON.parse(list.stdout) as {
				items: Array<{ slug: string; timestamp: string; artifactPath: string }>;
			};
			assert.equal(parsedList.items.length, 3);
			assert.equal(parsedList.items[0]?.slug, "search-ux");
			assert.equal(parsedList.items[0]?.timestamp, "20260508T010205Z");

			const history = runOmx(cwd, [
				"brainstorm",
				"history",
				"--slug",
				"search-ux",
				"--json",
			]);
			assert.equal(history.status, 0, history.stderr || history.stdout);
			const parsedHistory = JSON.parse(history.stdout) as {
				slug: string;
				items: Array<{
					slug: string;
					artifactPath: string;
					contextSnapshotPath: string | null;
					advisorFlags: { withClaude: boolean; withGemini: boolean };
				}>;
			};
			assert.equal(parsedHistory.slug, "search-ux");
			assert.equal(parsedHistory.items.length, 2);
			assert.equal(parsedHistory.items[0]?.slug, "search-ux");
			assert.equal(
				parsedHistory.items[0]?.artifactPath,
				latestSearch.path.replace(`${cwd}\\`, "").replace(/\\/g, "/"),
			);
			assert.equal(parsedHistory.items[0]?.advisorFlags.withClaude, true);
			assert.match(
				String(parsedHistory.items[0]?.contextSnapshotPath),
				/^\.omx\/context\//i,
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
			assert.match(latest.stdout, /Next actions:/);
			assert.match(latest.stdout, /Recommended: Approve for ralplan -> \$ralplan --from-design/);
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

	it("resumes an approved brainstorm artifact into a fresh draft version", async () => {
		const cwd = await initRepo();
		try {
			const original = await writeBrainstormArtifact({
				repoRoot: cwd,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				advisorFlags: { withClaude: true, withGemini: false },
				advisorRuns: {
					claude: {
						enabled: true,
						status: "succeeded",
						artifactPath: ".omx/artifacts/ask-claude-test.md",
						exitCode: 0,
						summary: "Claude recommends a staged rollout with explicit observability gates.",
						error: null,
						actionItems: ["Verify observability before rollout."],
					},
					gemini: {
						enabled: false,
						status: "skipped",
						artifactPath: null,
						exitCode: null,
						summary: "Advisor not requested.",
						error: null,
						actionItems: [],
					},
				},
				approvalState: "approved_for_ralplan",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});

			const resumed = runOmx(cwd, [
				"brainstorm",
				"resume",
				"--slug",
				"search-ux",
			]);
			assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
			assert.match(resumed.stdout, /approved brainstorm artifact/i);
			assert.match(resumed.stdout, /Resumed from:/i);
			assert.match(resumed.stdout, /Next actions:/);
			assert.match(resumed.stdout, /Recommended: Continue this brainstorm -> omx brainstorm resume --slug search-ux/);

			const specsDir = join(cwd, ".omx", "specs");
			const entries = await readdir(specsDir);
			assert.equal(entries.filter((name) => /^brainstorm-.*search-ux\.md$/i.test(name)).length, 2);

			const latest = runOmx(cwd, [
				"brainstorm",
				"status",
				"--slug",
				"search-ux",
				"--json",
			]);
			assert.equal(latest.status, 0, latest.stderr || latest.stdout);
			const parsedLatest = JSON.parse(latest.stdout);
			assert.equal(parsedLatest.artifact.approvalState, "draft");
			assert.notEqual(parsedLatest.artifact.path, original.path);
			assert.equal(parsedLatest.artifact.advisorRuns.claude.enabled, false);
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
			assert.match(result.stdout, /Next actions:/);
			assert.match(result.stdout, /Recommended: Continue this brainstorm -> omx brainstorm resume --slug seed-ci/);

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
