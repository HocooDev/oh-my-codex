import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createSeededBrainstormDraft,
	type BrainstormQuestionIO,
	type BrainstormStructuredQuestionAsker,
	parseInitArgs,
	runBrainstormNoviceBridge,
} from "../brainstorm-guided.js";
import {
	readLatestBrainstormArtifactForSlug,
	resolveBrainstormStatus,
	writeBrainstormArtifact,
} from "../brainstorm-intake.js";

async function initWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "omx-brainstorm-guided-test-"));
}

function withMockedTty<T>(fn: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value: true,
	});
	return fn().finally(() => {
		if (descriptor) {
			Object.defineProperty(process.stdin, "isTTY", descriptor);
		} else {
			Object.defineProperty(process.stdin, "isTTY", {
				configurable: true,
				value: false,
			});
		}
	});
}

function makeFakeIo(answers: string[]): BrainstormQuestionIO {
	const queue = [...answers];
	return {
		async question(): Promise<string> {
			return queue.shift() ?? "";
		},
		close(): void {},
	};
}

function makeFakeStructuredQuestionAsker(
	answers: string[],
	questions: Array<{
		question: string;
		options: string[];
		allowOther: boolean;
	}> = [],
): BrainstormStructuredQuestionAsker {
	const queue = [...answers];
	return async (input) => {
		questions.push({
			question: input.question,
			options: input.options.map((option) => option.value),
			allowOther: input.allow_other,
		});
		const next = queue.shift() ?? "";
		const matchingOption = input.options.find(
			(option) => option.value === next,
		);
		const answer = matchingOption
			? {
					kind: "option" as const,
					value: matchingOption.value,
					selected_labels: [matchingOption.label],
					selected_values: [matchingOption.value],
				}
			: {
					kind: "other" as const,
					value: next,
					selected_labels: [input.other_label ?? "Other"],
					selected_values: [next],
					other_text: next,
				};

		return {
			ok: true,
			question_id: `q-${questions.length}`,
			questions: [
				{
					id: "q-1",
					header: input.header,
					question: input.question,
					options: input.options,
					allow_other: input.allow_other,
					other_label: input.other_label ?? "Other",
					multi_select: input.multi_select ?? false,
					type:
						input.type ??
						(input.multi_select ? "multi-answerable" : "single-answerable"),
				},
			],
			answers: [{ question_id: "q-1", index: 0, answer }],
			prompt: {
				header: input.header,
				question: input.question,
				options: input.options,
				allow_other: input.allow_other,
				other_label: input.other_label ?? "Other",
				multi_select: input.multi_select ?? false,
				source: input.source,
			},
			answer,
		};
	};
}

describe("brainstorm parseInitArgs", () => {
	it("parses space-separated flags plus advisor toggles", () => {
		const result = parseInitArgs([
			"--idea",
			"Review search UX",
			"--slug",
			"search-ux",
			"--lang",
			"zh-CN",
			"--with-claude",
			"--with-gemini",
		]);
		assert.equal(result.idea, "Review search UX");
		assert.equal(result.slug, "search-ux");
		assert.equal(result.lang, "zh-CN");
		assert.equal(result.withClaude, true);
		assert.equal(result.withGemini, true);
	});

	it("accepts positional idea text and sanitizes slug", () => {
		const result = parseInitArgs([
			"--slug",
			"../../search ux",
			"Review",
			"search",
			"UX",
		]);
		assert.equal(result.idea, "Review search UX");
		assert.equal(result.slug, "search-ux");
	});

	it("rejects unknown flags and invalid languages", () => {
		assert.throws(
			() => parseInitArgs(["--unknown"]),
			/Unknown brainstorm init flag/i,
		);
		assert.throws(
			() => parseInitArgs(["--lang", "fr"]),
			/--lang must be one of/i,
		);
	});

	it("rejects missing values before the next flag", () => {
		assert.throws(
			() => parseInitArgs(["--slug", "--with-claude"]),
			/Missing value for --slug/i,
		);
		assert.throws(
			() => parseInitArgs(["--lang", "--with-gemini"]),
			/Missing value for --lang/i,
		);
	});
});

describe("brainstorm guided runtime", () => {
	it("writes context + canonical artifact and records continue-exploring draft state", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runBrainstormNoviceBridge(
					repo,
					{ slug: "search-ux" },
					makeFakeIo([
						"Explore search UX",
						"en",
						"Produce a reviewable search UX direction",
						"",
						"",
						"1",
					]),
				),
			);

			assert.equal(result.slug, "search-ux");
			assert.equal(result.approvalState, "continue_exploring");
			assert.match(
				result.brainstormArtifactPath,
				/brainstorm-\d{8}T\d{6}Z-search-ux\.md$/,
			);
			assert.equal(existsSync(result.contextSnapshotPath), true);
			assert.equal(existsSync(result.brainstormArtifactPath), true);
			assert.equal(
				existsSync(join(repo, ".omx", "state", "deep-interview-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(repo, ".omx", "state", "ralplan-state.json")),
				false,
			);

			const content = await readFile(result.brainstormArtifactPath, "utf-8");
			assert.match(content, /# Brainstorm Report:/);
			assert.match(content, /artifact:\n[\s\S]*status: draft/);
			assert.match(content, /recommended_next_skill: none/);
			assert.match(content, /approval_state: continue_exploring/);

			const state = JSON.parse(
				await readFile(
					join(repo, ".omx", "state", "brainstorm-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.equal(state.active, false);
			assert.equal(state.approval_state, "continue_exploring");
			assert.equal(state.selected_next_skill, "none");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("persists deep-interview approval metadata through the fixed confirmation bridge", async () => {
		const repo = await initWorkspace();
		const questions: Array<{
			question: string;
			options: string[];
			allowOther: boolean;
		}> = [];
		try {
			const result = await withMockedTty(() =>
				runBrainstormNoviceBridge(
					repo,
					{},
					makeFakeIo([]),
					makeFakeStructuredQuestionAsker(
						[
							"Shape the API review flow",
							"en",
							"Capture an approval-ready design direction",
							"No new dependencies",
							"What should deep-interview clarify next?",
							"approved_for_deep_interview",
						],
						questions,
					),
				),
			);

			assert.equal(result.approvalState, "approved_for_deep_interview");
			assert.equal(result.selectedNextSkill, "deep-interview");
			const approvalQuestion = questions.find((entry) =>
				/Choose the next action/i.test(entry.question),
			);
			assert.deepEqual(approvalQuestion?.options, [
				"continue_exploring",
				"approved_for_deep_interview",
				"approved_for_ralplan",
				"stopped",
			]);

			const content = await readFile(result.brainstormArtifactPath, "utf-8");
			assert.match(content, /status: approved/);
			assert.match(content, /recommended_next_skill: deep-interview/);
			assert.match(content, /selected_next_skill: deep-interview/);
			assert.match(content, /approval_state: approved_for_deep_interview/);
			assert.match(content, /\$deep-interview "/);

			const state = JSON.parse(
				await readFile(
					join(repo, ".omx", "state", "brainstorm-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.equal(state.recommended_next_skill, "deep-interview");
			assert.equal(state.selected_next_skill, "deep-interview");
			assert.equal(
				existsSync(join(repo, ".omx", "state", "deep-interview-state.json")),
				false,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("persists ralplan approval metadata without auto-launching ralplan", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runBrainstormNoviceBridge(
					repo,
					{ idea: "Finalize rollout direction", lang: "en" },
					makeFakeIo([
						"",
						"",
						"Approve a rollout-ready design direction",
						"Preserve existing rollout contract",
						"Can planning start immediately?",
						"3",
					]),
				),
			);

			assert.equal(result.approvalState, "approved_for_ralplan");
			assert.equal(result.selectedNextSkill, "ralplan");
			const content = await readFile(result.brainstormArtifactPath, "utf-8");
			assert.match(content, /status: approved/);
			assert.match(content, /recommended_next_skill: ralplan/);
			assert.match(content, /selected_next_skill: ralplan/);
			assert.match(content, /\$ralplan --from-design/);
			assert.equal(
				existsSync(join(repo, ".omx", "state", "ralplan-state.json")),
				false,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("records stop as a no-implementation outcome and keeps the artifact in draft state", async () => {
		const repo = await initWorkspace();
		try {
			const result = await withMockedTty(() =>
				runBrainstormNoviceBridge(
					repo,
					{ idea: "Investigate archival idea", lang: "en" },
					makeFakeIo([
						"",
						"",
						"Decide whether implementation should proceed at all",
						"",
						"Should this stop here?",
						"4",
					]),
				),
			);

			assert.equal(result.approvalState, "stopped");
			assert.equal(result.selectedNextSkill, "none");
			const content = await readFile(result.brainstormArtifactPath, "utf-8");
			assert.match(content, /status: draft/);
			assert.match(content, /approval_state: stopped/);
			assert.match(content, /recommended_next_skill: none/);
			assert.match(
				content,
				/Suggested next command: No follow-up command approved\./,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("selects the latest brainstorm artifact for a slug and pairs it with brainstorm state", async () => {
		const repo = await initWorkspace();
		try {
			await mkdir(join(repo, ".omx", "state"), { recursive: true });
			const older = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "approved_for_ralplan",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});
			const newer = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "draft",
				now: new Date("2026-05-08T01:02:04.000Z"),
			});

			assert.notEqual(older.path, newer.path);
			assert.equal(
				readLatestBrainstormArtifactForSlug(repo, "search-ux")?.path,
				newer.path,
			);

			const state = {
				active: false,
				mode: "brainstorm",
				current_phase: "completed",
				approval_state: "draft",
				slug: "search-ux",
				brainstorm_artifact_path: newer.path,
			};
			await writeFile(
				join(repo, ".omx", "state", "brainstorm-state.json"),
				JSON.stringify(state, null, 2),
				"utf-8",
			);

			const status = await resolveBrainstormStatus(repo, { slug: "search-ux" });
			assert.equal(status.artifact?.path, newer.path);
			assert.equal(status.state?.slug, "search-ux");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("does not pair the latest artifact with stale state from an older artifact path", async () => {
		const repo = await initWorkspace();
		try {
			const older = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "approved_for_ralplan",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});
			const newer = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				approvalState: "draft",
				now: new Date("2026-05-08T01:02:04.000Z"),
			});

			await mkdir(join(repo, ".omx", "state"), { recursive: true });
			await writeFile(
				join(repo, ".omx", "state", "brainstorm-state.json"),
				JSON.stringify(
					{
						active: false,
						mode: "brainstorm",
						current_phase: "completed",
						approval_state: "approved_for_ralplan",
						slug: "search-ux",
						brainstorm_artifact_path: older.path,
					},
					null,
					2,
				),
				"utf-8",
			);

			const status = await resolveBrainstormStatus(repo, { slug: "search-ux" });
			assert.equal(status.artifact?.path, newer.path);
			assert.equal(status.state, null);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("writes a fresh context snapshot when the slug is reused with changed inputs", async () => {
		const repo = await initWorkspace();
		try {
			const first = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				constraints: "Keep current debounce behavior",
				now: new Date("2026-05-08T01:02:03.000Z"),
			});
			const second = await writeBrainstormArtifact({
				repoRoot: repo,
				idea: "Review search UX",
				slug: "search-ux",
				lang: "en",
				constraints: "Replace debounce behavior",
				now: new Date("2026-05-08T01:02:04.000Z"),
			});

			assert.notEqual(first.contextSnapshotPath, second.contextSnapshotPath);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("marks brainstorm state failed when approval prompting aborts after draft activation", async () => {
		const repo = await initWorkspace();
		try {
			await assert.rejects(
				withMockedTty(() =>
					runBrainstormNoviceBridge(
						repo,
						{ idea: "Abort after draft", lang: "en" },
						makeFakeIo(["", "", "Keep it safe", "", "", "bogus"]),
					),
				),
				/Please choose 1, 2, 3, or 4/i,
			);

			const state = JSON.parse(
				await readFile(
					join(repo, ".omx", "state", "brainstorm-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.equal(state.active, false);
			assert.equal(state.current_phase, "failed");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("creates a seeded draft without an interactive terminal", async () => {
		const repo = await initWorkspace();
		try {
			const result = await createSeededBrainstormDraft(repo, {
				idea: "Seed from CI",
				slug: "seed-from-ci",
				lang: "en",
			});
			assert.equal(result.approvalState, "draft");
			assert.equal(existsSync(result.brainstormArtifactPath), true);

			const state = JSON.parse(
				await readFile(
					join(repo, ".omx", "state", "brainstorm-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.equal(state.active, false);
			assert.equal(state.current_phase, "draft_saved");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
