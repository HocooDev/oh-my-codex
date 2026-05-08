import { createInterface } from "node:readline/promises";
import { slugifyMissionName } from "../autoresearch/contracts.js";
import { startMode, updateModeState } from "../modes/base.js";
import {
	OmxQuestionError,
	type OmxQuestionSuccessPayload,
} from "../question/client.js";
import { runDeepInterviewQuestion } from "../question/deep-interview.js";
import { evaluateQuestionPolicy } from "../question/policy.js";
import type { QuestionType } from "../question/types.js";
import {
	BRAINSTORM_LANGS,
	type BrainstormApprovalState,
	type BrainstormLanguage,
	type BrainstormRecommendedNextSkill,
	type BrainstormSeedInputs,
	type BrainstormSelectedNextSkill,
	type ResolvedBrainstormLanguage,
	resolveBrainstormLanguage,
	writeBrainstormArtifact,
} from "./brainstorm-intake.js";

export interface InitBrainstormOptions {
	idea: string;
	slug: string;
	lang: BrainstormLanguage;
	withClaude: boolean;
	withGemini: boolean;
	repoRoot: string;
}

export interface InitBrainstormResult {
	slug: string;
	lang: ResolvedBrainstormLanguage;
	contextSnapshotPath: string;
	brainstormArtifactPath: string;
	approvalState: BrainstormApprovalState;
	recommendedNextSkill: BrainstormRecommendedNextSkill;
	selectedNextSkill: BrainstormSelectedNextSkill;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface BrainstormQuestionIO {
	question(prompt: string): Promise<string>;
	close(): void;
}

export interface BrainstormStructuredQuestionInput {
	header?: string;
	question: string;
	options: Array<{ label: string; value: string; description?: string }>;
	allow_other: boolean;
	other_label?: string;
	multi_select?: boolean;
	type?: QuestionType;
	source?: string;
}

export type BrainstormStructuredQuestionAsker = (
	input: BrainstormStructuredQuestionInput,
) => Promise<OmxQuestionSuccessPayload>;

const BRAINSTORM_CONFIRM_OPTIONS = [
	{
		label: "Continue exploring",
		value: "continue_exploring",
		description:
			"Keep the report in draft state and record that more exploration is needed.",
	},
	{
		label: "Handoff to deep-interview",
		value: "approved_for_deep_interview",
		description:
			"Approve the draft for requirements clarification without auto-launching the workflow.",
	},
	{
		label: "Handoff to ralplan",
		value: "approved_for_ralplan",
		description:
			"Approve the draft for planning without auto-launching the workflow.",
	},
	{
		label: "Stop",
		value: "stopped",
		description:
			"Record a no-implementation outcome and leave the artifact in draft state.",
	},
] as const;

function createQuestionIO(): BrainstormQuestionIO {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return {
		question(prompt: string) {
			return rl.question(prompt);
		},
		close() {
			rl.close();
		},
	};
}

function primaryStructuredAnswer(
	response: OmxQuestionSuccessPayload,
): OmxQuestionSuccessPayload["answers"][number]["answer"] {
	const answer = response.answers[0]?.answer ?? response.answer;
	if (!answer) throw new Error("Structured question returned no answer.");
	return answer;
}

function createStructuredQuestionAsker(
	repoRoot: string,
): BrainstormStructuredQuestionAsker {
	return (input) =>
		runDeepInterviewQuestion(
			{
				header: input.header,
				question: input.question,
				options: input.options,
				allow_other: input.allow_other,
				other_label: input.other_label ?? "Other",
				type: input.type,
				multi_select: input.multi_select ?? false,
				source: input.source ?? "brainstorm",
			},
			{ cwd: repoRoot },
		);
}

function shouldFallbackFromStructuredQuestion(error: unknown): boolean {
	if (error instanceof OmxQuestionError) {
		if (
			error.code === "worker_blocked" ||
			error.code === "team_blocked" ||
			error.code === "active_execution_mode_blocked"
		) {
			return false;
		}
		return true;
	}

	const message = error instanceof Error ? error.message : String(error);
	return /omx question/i.test(message);
}

async function ensureStructuredQuestionFallbackAllowed(
	repoRoot: string,
): Promise<void> {
	const policy = await evaluateQuestionPolicy({ cwd: repoRoot });
	if (policy.allowed || policy.fallbackAllowed !== false) return;
	throw new OmxQuestionError(
		policy.code ?? "question_policy_denied",
		policy.message ??
			"Structured questions are unavailable in the current OMX workflow context.",
	);
}

async function promptWithDefault(
	io: BrainstormQuestionIO,
	prompt: string,
	currentValue?: string,
	structuredQuestion?: BrainstormStructuredQuestionAsker,
): Promise<string> {
	if (structuredQuestion) {
		const trimmedCurrentValue = currentValue?.trim() || "";
		const response = await structuredQuestion({
			header: "Brainstorm",
			question: prompt,
			options: trimmedCurrentValue
				? [
						{
							label: "Keep current value",
							value: trimmedCurrentValue,
							description: trimmedCurrentValue,
						},
					]
				: [],
			allow_other: true,
			other_label: trimmedCurrentValue
				? "Enter a different value"
				: "Enter your response",
			source: "brainstorm",
		});
		const answer = primaryStructuredAnswer(response);
		const answerValue =
			answer.other_text?.trim() ||
			(typeof answer.value === "string" ? answer.value.trim() : "");
		return answerValue || trimmedCurrentValue || "";
	}

	const suffix = currentValue?.trim() ? ` [${currentValue.trim()}]` : "";
	const answer = await io.question(`${prompt}${suffix}\n> `);
	return answer.trim() || currentValue?.trim() || "";
}

async function promptLanguage(
	io: BrainstormQuestionIO,
	currentValue: BrainstormLanguage,
	structuredQuestion?: BrainstormStructuredQuestionAsker,
): Promise<BrainstormLanguage> {
	if (structuredQuestion) {
		const response = await structuredQuestion({
			header: "Brainstorm",
			question: "Artifact language",
			options: BRAINSTORM_LANGS.map((lang) => ({
				label: lang,
				value: lang,
				description:
					lang === "auto"
						? "Detect from the idea text."
						: `Use ${lang} for body text and metadata.`,
			})),
			allow_other: false,
			source: "brainstorm",
		});
		const answer = primaryStructuredAnswer(response);
		const answerValue =
			typeof answer.value === "string" ? answer.value.trim() : "";
		if (BRAINSTORM_LANGS.includes(answerValue as BrainstormLanguage)) {
			return answerValue as BrainstormLanguage;
		}
		throw new Error("Structured question returned an invalid language.");
	}

	const answer = (
		await io.question(
			`Artifact language [${BRAINSTORM_LANGS.join("/")}] [${currentValue}]\n> `,
		)
	).trim();
	const selected = (answer || currentValue).trim() as BrainstormLanguage;
	if (!BRAINSTORM_LANGS.includes(selected)) {
		throw new Error(`--lang must be one of: ${BRAINSTORM_LANGS.join(", ")}`);
	}
	return selected;
}

async function promptApprovalState(
	io: BrainstormQuestionIO,
	structuredQuestion?: BrainstormStructuredQuestionAsker,
): Promise<BrainstormApprovalState> {
	if (structuredQuestion) {
		const response = await structuredQuestion({
			header: "Brainstorm",
			question: "Choose the next action for this brainstorm artifact",
			options: [...BRAINSTORM_CONFIRM_OPTIONS],
			allow_other: false,
			source: "brainstorm",
		});
		const answer = primaryStructuredAnswer(response);
		const answerValue =
			typeof answer.value === "string" ? answer.value.trim() : "";
		if (
			BRAINSTORM_CONFIRM_OPTIONS.some((option) => option.value === answerValue)
		) {
			return answerValue as BrainstormApprovalState;
		}
		throw new Error(
			"Structured question returned an invalid brainstorm approval state.",
		);
	}

	const answer = (
		await io.question(
			[
				"\nChoose the next action:",
				"  1. continue exploring",
				"  2. approve and hand off to deep-interview",
				"  3. approve and hand off to ralplan",
				"  4. stop / no implementation",
				"> ",
			].join("\n"),
		)
	)
		.trim()
		.toLowerCase();

	if (
		!answer ||
		answer === "1" ||
		answer === "continue" ||
		answer === "continue exploring"
	) {
		return "continue_exploring";
	}
	if (
		answer === "2" ||
		answer === "deep-interview" ||
		answer === "handoff to deep-interview"
	) {
		return "approved_for_deep_interview";
	}
	if (
		answer === "3" ||
		answer === "ralplan" ||
		answer === "handoff to ralplan"
	) {
		return "approved_for_ralplan";
	}
	if (answer === "4" || answer === "stop" || answer === "no implementation") {
		return "stopped";
	}
	throw new Error("Please choose 1, 2, 3, or 4.");
}

function withStructuredQuestionFallback<T>(
	activeStructuredQuestion: { current?: BrainstormStructuredQuestionAsker },
	warned: { current: boolean },
	operation: (question?: BrainstormStructuredQuestionAsker) => Promise<T>,
): Promise<T> {
	const current = activeStructuredQuestion.current;
	if (!current) return operation();

	return operation(current).catch((error) => {
		if (!shouldFallbackFromStructuredQuestion(error)) throw error;
		activeStructuredQuestion.current = undefined;
		if (!warned.current) {
			warned.current = true;
			console.warn(
				`[omx] warning: structured question UI unavailable (${error instanceof Error ? error.message : String(error)}). Falling back to plain terminal prompts.`,
			);
		}
		return operation();
	});
}

async function withRepoLocalStateRoot<T>(
	operation: () => Promise<T>,
): Promise<T> {
	const prior = {
		OMX_ROOT: process.env.OMX_ROOT,
		OMX_STATE_ROOT: process.env.OMX_STATE_ROOT,
		OMX_TEAM_STATE_ROOT: process.env.OMX_TEAM_STATE_ROOT,
	};
	delete process.env.OMX_ROOT;
	delete process.env.OMX_STATE_ROOT;
	delete process.env.OMX_TEAM_STATE_ROOT;
	try {
		return await operation();
	} finally {
		for (const [key, value] of Object.entries(prior)) {
			if (value == null) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

export function parseInitArgs(
	args: readonly string[],
): Partial<InitBrainstormOptions> {
	const result: Partial<InitBrainstormOptions> = {};
	const positionalIdea: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		const next = args[i + 1];
		if (arg === "--idea") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --idea.");
			}
			result.idea = next;
			i += 1;
		} else if (arg === "--slug") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --slug.");
			}
			result.slug = slugifyMissionName(next);
			i += 1;
		} else if (arg === "--lang") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --lang.");
			}
			if (!BRAINSTORM_LANGS.includes(next as BrainstormLanguage)) {
				throw new Error(
					`--lang must be one of: ${BRAINSTORM_LANGS.join(", ")}`,
				);
			}
			result.lang = next as BrainstormLanguage;
			i += 1;
		} else if (arg === "--with-claude") {
			result.withClaude = true;
		} else if (arg === "--with-gemini") {
			result.withGemini = true;
		} else if (arg.startsWith("--idea=")) {
			result.idea = arg.slice("--idea=".length);
		} else if (arg.startsWith("--slug=")) {
			result.slug = slugifyMissionName(arg.slice("--slug=".length));
		} else if (arg.startsWith("--lang=")) {
			const lang = arg.slice("--lang=".length);
			if (!BRAINSTORM_LANGS.includes(lang as BrainstormLanguage)) {
				throw new Error(
					`--lang must be one of: ${BRAINSTORM_LANGS.join(", ")}`,
				);
			}
			result.lang = lang as BrainstormLanguage;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown brainstorm init flag: ${arg.split("=")[0]}`);
		} else {
			positionalIdea.push(arg);
		}
	}

	if (!result.idea && positionalIdea.length > 0) {
		result.idea = positionalIdea.join(" ");
	}
	if (!result.slug && result.idea?.trim()) {
		result.slug = slugifyMissionName(result.idea);
	}
	if (!result.lang) {
		result.lang = "auto";
	}

	return result;
}

export async function createSeededBrainstormDraft(
	repoRoot: string,
	seedInputs: BrainstormSeedInputs,
): Promise<InitBrainstormResult> {
	const idea = seedInputs.idea?.trim() || "";
	if (!idea) {
		throw new Error("Brainstorm idea is required.");
	}

	const slug = slugifyMissionName(seedInputs.slug?.trim() || idea);
	const draft = await writeBrainstormArtifact({
		repoRoot,
		idea,
		slug,
		lang: seedInputs.lang,
		advisorFlags: {
			withClaude: seedInputs.withClaude === true,
			withGemini: seedInputs.withGemini === true,
		},
		approvalState: "draft",
	});

	await withRepoLocalStateRoot(async () => {
		await startMode("brainstorm", idea, 1, repoRoot);
		await updateModeState(
			"brainstorm",
			{
				active: false,
				current_phase: "draft_saved",
				completed_at: new Date().toISOString(),
				slug: draft.compileTarget.slug,
				context_snapshot_path: draft.contextSnapshotPath,
				brainstorm_artifact_path: draft.path,
				lang: draft.compileTarget.lang,
				advisor_flags: draft.compileTarget.advisorFlags,
				recommended_next_skill: draft.recommendedNextSkill,
				selected_next_skill: draft.selectedNextSkill,
				approval_state: draft.approvalState,
				completion_note:
					"brainstorm seed draft created without interactive approval bridge",
			},
			repoRoot,
		);
	});

	return {
		slug: draft.compileTarget.slug,
		lang: draft.compileTarget.lang,
		contextSnapshotPath: draft.contextSnapshotPath,
		brainstormArtifactPath: draft.path,
		approvalState: draft.approvalState,
		recommendedNextSkill: draft.recommendedNextSkill,
		selectedNextSkill: draft.selectedNextSkill,
	};
}

export async function runBrainstormNoviceBridge(
	repoRoot: string,
	seedInputs: BrainstormSeedInputs = {},
	io: BrainstormQuestionIO = createQuestionIO(),
	structuredQuestion?: BrainstormStructuredQuestionAsker,
): Promise<InitBrainstormResult> {
	if (!process.stdin.isTTY) {
		throw new Error(
			"Guided brainstorm setup requires an interactive terminal. Use `--idea/--slug/--lang` to seed the artifact draft, then rerun interactively to confirm the handoff.",
		);
	}

	let idea = seedInputs.idea?.trim() || "";
	let lang: BrainstormLanguage = seedInputs.lang ?? "auto";
	let desiredOutcome = "";
	let constraints = "";
	let openQuestions = "";
	let modeActivated = false;
	const advisorFlags = {
		withClaude: seedInputs.withClaude === true,
		withGemini: seedInputs.withGemini === true,
	};
	const structuredRef = { current: structuredQuestion };
	const warnedAboutStructuredFallback = { current: false };

	try {
		idea = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) => promptWithDefault(io, "Idea / proposal", idea, question),
		);
		if (!idea) throw new Error("Brainstorm idea is required.");

		lang = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) => promptLanguage(io, lang, question),
		);
		const resolvedLang = resolveBrainstormLanguage(lang, idea);

		desiredOutcome = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) =>
				promptWithDefault(
					io,
					"Desired outcome for this brainstorm artifact",
					desiredOutcome ||
						(resolvedLang === "zh-CN" || resolvedLang === "zh-TW"
							? `为以下想法整理一个可审阅的设计方向：${idea}`
							: `Explore a reviewable design direction for: ${idea}`),
					question,
				),
		);

		constraints = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) =>
				promptWithDefault(
					io,
					"Key constraints or concerns",
					constraints || "",
					question,
				),
		);

		openQuestions = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) =>
				promptWithDefault(
					io,
					"Open questions to preserve",
					openQuestions || "",
					question,
				),
		);

		const slug = slugifyMissionName(seedInputs.slug?.trim() || idea);
		const draft = await writeBrainstormArtifact({
			repoRoot,
			idea,
			desiredOutcome,
			constraints,
			openQuestions,
			slug,
			lang,
			advisorFlags,
			approvalState: "draft",
		});

		await withRepoLocalStateRoot(async () => {
			await startMode("brainstorm", idea, 1, repoRoot);
			await updateModeState(
				"brainstorm",
				{
					active: true,
					iteration: 1,
					current_phase: "awaiting_confirmation",
					slug: draft.compileTarget.slug,
					context_snapshot_path: draft.contextSnapshotPath,
					brainstorm_artifact_path: draft.path,
					lang: draft.compileTarget.lang,
					advisor_flags: advisorFlags,
					recommended_next_skill: "none",
					selected_next_skill: "none",
					approval_state: "draft",
				},
				repoRoot,
			);
		});
		modeActivated = true;

		console.log(`\nDraft saved: ${draft.path}`);

		const approvalState = await withStructuredQuestionFallback(
			structuredRef,
			warnedAboutStructuredFallback,
			(question) => promptApprovalState(io, question),
		);

		const finalized = await writeBrainstormArtifact({
			repoRoot,
			idea,
			desiredOutcome,
			constraints,
			openQuestions,
			slug: draft.compileTarget.slug,
			lang,
			advisorFlags,
			approvalState,
		});

		await withRepoLocalStateRoot(async () => {
			await updateModeState(
				"brainstorm",
				{
					active: false,
					current_phase: "completed",
					completed_at: new Date().toISOString(),
					slug: finalized.compileTarget.slug,
					context_snapshot_path: finalized.contextSnapshotPath,
					brainstorm_artifact_path: finalized.path,
					lang: finalized.compileTarget.lang,
					advisor_flags: advisorFlags,
					recommended_next_skill: finalized.recommendedNextSkill,
					selected_next_skill: finalized.selectedNextSkill,
					approval_state: finalized.approvalState,
					completion_note:
						"brainstorm guided runtime completed without auto-launching downstream workflows",
				},
				repoRoot,
			);
		});

		return {
			slug: finalized.compileTarget.slug,
			lang: finalized.compileTarget.lang,
			contextSnapshotPath: finalized.contextSnapshotPath,
			brainstormArtifactPath: finalized.path,
			approvalState: finalized.approvalState,
			recommendedNextSkill: finalized.recommendedNextSkill,
			selectedNextSkill: finalized.selectedNextSkill,
		};
	} catch (error) {
		if (modeActivated) {
			await withRepoLocalStateRoot(async () => {
				try {
					await updateModeState(
						"brainstorm",
						{
							active: false,
							current_phase: "failed",
							completed_at: new Date().toISOString(),
							error: errorMessage(error),
						},
						repoRoot,
					);
				} catch {
					// best-effort cleanup only
				}
			});
		}
		throw error;
	} finally {
		io.close();
	}
}

export async function guidedBrainstormSetup(
	repoRoot: string,
	seedInputs: BrainstormSeedInputs = {},
): Promise<InitBrainstormResult> {
	await ensureStructuredQuestionFallbackAllowed(repoRoot);
	return runBrainstormNoviceBridge(
		repoRoot,
		seedInputs,
		createQuestionIO(),
		createStructuredQuestionAsker(repoRoot),
	);
}
