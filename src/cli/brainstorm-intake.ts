import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { slugifyMissionName } from "../autoresearch/contracts.js";
import {
	analyzeBrainstormRepoContext,
	type BrainstormRepoContext,
} from "./brainstorm-repo-context.js";
import {
	BRAINSTORM_ADVISOR_PROVIDERS,
	BRAINSTORM_APPROVAL_STATES,
	BRAINSTORM_NEXT_SKILLS,
	type BrainstormApprovalState,
	type BrainstormAdvisorProvider,
	type BrainstormAdvisorRun,
	type BrainstormAdvisorRuns,
	type BrainstormArtifactRecord,
	readBrainstormArtifactHistoryForSlug,
	readBrainstormArtifacts,
	type BrainstormSelectedNextSkill,
	readLatestBrainstormArtifact,
	readLatestBrainstormArtifactForSlug,
} from "../planning/artifacts.js";

export type {
	BrainstormApprovalState,
	BrainstormAdvisorProvider,
	BrainstormAdvisorRun,
	BrainstormAdvisorRuns,
	BrainstormSelectedNextSkill,
} from "../planning/artifacts.js";
export { readLatestBrainstormArtifactForSlug } from "../planning/artifacts.js";

export const BRAINSTORM_LANGS = ["auto", "en", "zh-CN", "zh-TW"] as const;
export type BrainstormLanguage = (typeof BRAINSTORM_LANGS)[number];
export type ResolvedBrainstormLanguage = Exclude<BrainstormLanguage, "auto">;
export type BrainstormRecommendedNextSkill =
	(typeof BRAINSTORM_NEXT_SKILLS)[number];

export interface BrainstormAdvisorFlags {
	withClaude: boolean;
	withGemini: boolean;
}

export interface BrainstormSeedInputs {
	idea?: string;
	slug?: string;
	lang?: BrainstormLanguage;
	withClaude?: boolean;
	withGemini?: boolean;
	nonInteractive?: boolean;
	desiredOutcome?: string;
	constraints?: string;
	openQuestions?: string;
}

export interface BrainstormArtifactListItem {
	slug: string;
	timestamp: string | null;
	title: string | null;
	artifactStatus: string | null;
	approvalState: BrainstormApprovalState | null;
	recommendedNextSkill: BrainstormRecommendedNextSkill | null;
	artifactPath: string;
}

export interface BrainstormHistoryItem extends BrainstormArtifactListItem {
	contextSnapshotPath: string | null;
	advisorFlags: BrainstormAdvisorFlags;
	advisorRuns: BrainstormAdvisorRuns | null;
}

export interface BrainstormListResult {
	items: BrainstormArtifactListItem[];
}

export interface BrainstormHistoryResult {
	slug: string;
	items: BrainstormHistoryItem[];
}

export interface BrainstormResumeSeed {
	sourceArtifact: BrainstormArtifactRecord;
	seedInputs: Required<
		Pick<
			BrainstormSeedInputs,
			"idea" | "slug" | "lang" | "withClaude" | "withGemini"
		>
	> &
		Pick<
			BrainstormSeedInputs,
			"desiredOutcome" | "constraints" | "openQuestions"
		>;
	note: string | null;
}

export interface BrainstormDraftCompileTarget {
	idea: string;
	desiredOutcome: string;
	constraints: string;
	openQuestions: string;
	slug: string;
	lang: ResolvedBrainstormLanguage;
	repoRoot: string;
	advisorFlags: BrainstormAdvisorFlags;
}

interface BrainstormRenderedSections {
	currentUnderstanding: string;
	goals: string;
	constraints: string;
	openQuestions: string;
	candidateSolutions: string;
	recommendation: string;
	risks: string;
	testing: string;
}

export interface BrainstormArtifactDraft {
	compileTarget: BrainstormDraftCompileTarget;
	path: string;
	content: string;
	contextSnapshotPath: string;
	artifactWrittenAt: string;
	artifactStatus: "draft" | "approved";
	approvalState: BrainstormApprovalState;
	recommendedNextSkill: BrainstormRecommendedNextSkill;
	selectedNextSkill: BrainstormSelectedNextSkill;
	advisorRuns: BrainstormAdvisorRuns;
}

export interface BrainstormStatusResult {
	selector: { slug: string | null; latest: boolean };
	artifact: BrainstormArtifactRecord | null;
	state: Record<string, unknown> | null;
}

function normalizeAdvisorRunValue(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function defaultAdvisorSummary(
	provider: BrainstormAdvisorProvider,
	enabled: boolean,
): string | null {
	if (!enabled) return "Advisor not requested.";
	return `Advisor ${provider} requested, but no artifact was recorded yet.`;
}

export function normalizeBrainstormAdvisorRuns(
	advisorFlags: BrainstormAdvisorFlags,
	advisorRuns?: Partial<BrainstormAdvisorRuns> | null,
): BrainstormAdvisorRuns {
	const entries = BRAINSTORM_ADVISOR_PROVIDERS.map((provider) => {
		const enabled =
			provider === "claude"
				? advisorFlags.withClaude
				: advisorFlags.withGemini;
		const current = advisorRuns?.[provider];
		return [
			provider,
			{
				enabled,
				status: current?.status ?? (enabled ? "pending" : "skipped"),
				artifactPath: normalizeAdvisorRunValue(current?.artifactPath),
				exitCode:
					typeof current?.exitCode === "number" ? current.exitCode : null,
				summary:
					normalizeAdvisorRunValue(current?.summary) ??
					defaultAdvisorSummary(provider, enabled),
				error: normalizeAdvisorRunValue(current?.error),
				actionItems: Array.isArray(current?.actionItems)
					? current.actionItems.filter(
							(item): item is string => typeof item === "string" && item.trim().length > 0,
						)
					: [],
			},
		] as const satisfies readonly [BrainstormAdvisorProvider, BrainstormAdvisorRun];
	});

	return Object.fromEntries(entries) as BrainstormAdvisorRuns;
}

function normalizeMarkdown(content: string): string {
	return content.replace(/\r\n/g, "\n");
}

function extractMarkdownSection(content: string, headingPattern: RegExp): string {
	const lines = normalizeMarkdown(content).split("\n");
	const headingIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
	if (headingIndex < 0) return "";

	const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1].length ?? 1;
	const body: string[] = [];
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const nextHeading = lines[index].match(/^(#{1,6})\s+/);
		if (nextHeading && nextHeading[1].length <= headingLevel) break;
		body.push(lines[index]);
	}
	return body.join("\n").trim();
}

function cleanSectionText(value: string): string {
	return normalizeMarkdown(value).trim();
}

function sentenceCaseProvider(provider: BrainstormAdvisorProvider): string {
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function compactUtcTimestamp(now: Date = new Date()): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function containsHan(value: string): boolean {
	return /\p{Script=Han}/u.test(value);
}

export function resolveBrainstormLanguage(
	preferred: BrainstormLanguage | undefined,
	idea?: string,
): ResolvedBrainstormLanguage {
	if (preferred && preferred !== "auto") return preferred;
	return containsHan(idea ?? "") ? "zh-CN" : "en";
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string, max = 80): string {
	const trimmed = oneLine(value);
	if (!trimmed) return "Untitled brainstorm";
	return trimmed.length <= max
		? trimmed
		: `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function relativeOmxPath(repoRoot: string, absolutePath: string): string {
	return relative(repoRoot, absolutePath)
		.replace(/\\/g, "/")
		.replace(/^\.\//, "");
}

function contextDir(repoRoot: string): string {
	return join(repoRoot, ".omx", "context");
}

function specsDir(repoRoot: string): string {
	return join(repoRoot, ".omx", "specs");
}

function artifactStatusForApprovalState(
	approvalState: BrainstormApprovalState,
): "draft" | "approved" {
	return approvalState === "approved_for_deep_interview" ||
		approvalState === "approved_for_ralplan"
		? "approved"
		: "draft";
}

export function brainstormNextSkillForApprovalState(
	approvalState: BrainstormApprovalState,
): BrainstormRecommendedNextSkill {
	switch (approvalState) {
		case "approved_for_deep_interview":
			return "deep-interview";
		case "approved_for_ralplan":
			return "ralplan";
		default:
			return "none";
	}
}

export function selectedNextSkillForApprovalState(
	approvalState: BrainstormApprovalState,
): BrainstormSelectedNextSkill {
	return brainstormNextSkillForApprovalState(approvalState);
}

function isChineseBrainstormLanguage(
	lang: ResolvedBrainstormLanguage,
): boolean {
	return lang === "zh-CN" || lang === "zh-TW";
}

function shouldReuseArtifact(record: BrainstormArtifactRecord | null): boolean {
	if (!record) return false;
	return (
		record.approvalState === "draft" ||
		record.approvalState === "continue_exploring" ||
		(!record.approvalState &&
			(record.artifactStatus?.trim().toLowerCase() ?? "") === "draft")
	);
}

function localizedCopy(lang: ResolvedBrainstormLanguage): {
	currentUnderstanding: string;
	goals: string;
	nonGoals: string;
	constraintsFallback: string;
	openQuestionsFallback: string;
	candidateSolutions: string;
	recommendation: string;
	workflow: string;
	artifactContract: string;
	integration: string;
	risks: string;
	testing: string;
	continueDecision: string;
	stopDecision: string;
	advisorSection: string;
	advisorNotRequested: string;
	advisorPending: string;
	advisorSucceeded: string;
	advisorFailed: string;
	advisorArtifactLabel: string;
	advisorSummaryLabel: string;
	advisorErrorLabel: string;
	advisorExitCodeLabel: string;
	approvedRecommendationLabel: string;
	suggestedNextCommandLabel: string;
	handoffDecisionLabel: string;
	nextActionsHeading: string;
	recommendedActionLabel: string;
	continueActionLabel: string;
	deepInterviewActionLabel: string;
	ralplanActionLabel: string;
	stopActionLabel: string;
	likelyTouchedModulesHeading: string;
	relatedWorkflowsHeading: string;
	repoConstraintsHeading: string;
} {
	if (isChineseBrainstormLanguage(lang)) {
		return {
			currentUnderstanding:
				"此草稿记录当前已知的想法、约束和待确认问题，作为后续审批与交接的基础。",
			goals:
				"形成可审阅的设计方向，并保留后续是否交给 `$deep-interview` 或 `$ralplan` 的明确记录。",
			nonGoals:
				"- 本轮不做代码实现。\n- 本轮不产出最终执行计划。\n- 本轮不自动启动任何下游工作流。",
			constraintsFallback: "- 暂未记录额外约束；继续探索时补充。",
			openQuestionsFallback:
				"- 仍需确认是否进入 `$deep-interview`、`$ralplan`，或继续探索。",
			candidateSolutions:
				"- 草稿阶段：候选方案将在后续设计探索中补充。\n- 当前先记录审批与交接语义，避免方向丢失。",
			recommendation: "先固定当前想法与审批状态，再按记录的下一步工作流继续。",
			workflow:
				"- 使用 `omx brainstorm` / `omx brainstorm init` 生成或更新草稿。\n- 仅在审批后把产物交给后续工作流；本命令不会自动启动它们。",
			artifactContract:
				"- 主产物：规范化 markdown 报告。\n- 上下文快照：保存在 `.omx/context/`，供后续工作流引用。\n- CLI 状态：保存在 `.omx/state/brainstorm-state.json`。",
			integration:
				"- `$deep-interview`：用于澄清范围、目标、验收条件。\n- `$ralplan`：用于把已批准方向转成 PRD / test spec。\n- `$ralph` / `$team`：本轮不直接触发。",
			risks:
				"- 如果在草稿阶段就跳过审批，后续工作流可能继承未确认方向。\n- 如果上下文快照缺失，后续 intake 需要重新扫描背景。",
			testing:
				"- 校验 markdown 产物锚点与 `artifact:` 合约。\n- 校验状态文件与 markdown 中的审批字段一致。\n- 校验本命令不会自动创建 deep-interview / ralplan 运行态。",
			continueDecision: "继续探索，暂不批准交接。",
			stopDecision: "停止 / 暂不实现。",
			advisorSection: "外部顾问输入",
			advisorNotRequested: "未请求",
			advisorPending: "已请求，但尚未记录顾问产物。",
			advisorSucceeded: "成功",
			advisorFailed: "失败",
			advisorArtifactLabel: "顾问产物",
			advisorSummaryLabel: "摘要",
			advisorErrorLabel: "错误",
			advisorExitCodeLabel: "退出码",
			approvedRecommendationLabel: "批准建议",
			suggestedNextCommandLabel: "建议下一条命令",
			handoffDecisionLabel: "交接决定",
			nextActionsHeading: "下一步操作",
			recommendedActionLabel: "推荐动作",
			continueActionLabel: "继续这一轮 brainstorm",
			deepInterviewActionLabel: "批准交给 deep-interview",
			ralplanActionLabel: "批准交给 ralplan",
			stopActionLabel: "停止",
			likelyTouchedModulesHeading: "可能受影响的模块",
			relatedWorkflowsHeading: "现有相关工作流",
			repoConstraintsHeading: "当前仓库/运行时约束",
		};
	}

	return {
		currentUnderstanding:
			"This draft captures the current idea, constraints, and open questions so later approval and handoff decisions stay grounded.",
		goals:
			"Produce a reviewable design-direction artifact and preserve an explicit handoff target for `$deep-interview` or `$ralplan` when approved.",
		nonGoals:
			"- No code changes in this brainstorm runtime.\n- No final execution plan in this brainstorm runtime.\n- No automatic downstream workflow launch.",
		constraintsFallback:
			"- No extra constraints captured yet; continue exploring to refine them.",
		openQuestionsFallback:
			"- The next workflow still needs approval: `$deep-interview`, `$ralplan`, or more exploration.",
		candidateSolutions:
			"- Draft stage: candidate solutions will be expanded during follow-up design exploration.\n- This runtime first preserves approval and handoff semantics in a stable artifact.",
		recommendation:
			"Lock the current direction and approval state in the artifact first, then hand off through the recorded next workflow when ready.",
		workflow:
			"- Use `omx brainstorm` / `omx brainstorm init` to create or update the draft artifact.\n- Approvals only record the next workflow; this command does not auto-start it.",
		artifactContract:
			"- Primary artifact: canonical markdown design report.\n- Context snapshot: stored under `.omx/context/` for later workflows.\n- CLI/runtime state: stored under `.omx/state/brainstorm-state.json`.",
		integration:
			"- `$deep-interview` clarifies scope, goals, and acceptance criteria.\n- `$ralplan` converts the approved direction into PRD / test-spec artifacts.\n- `$ralph` / `$team` are intentionally out of scope for this runtime.",
		risks:
			"- Skipping approval would let downstream workflows inherit an unconfirmed direction.\n- Missing context snapshots would force later workflows to re-scan the background.",
		testing:
			"- Validate markdown anchors and the `artifact:` contract.\n- Validate that state and markdown approval metadata stay aligned.\n- Validate that brainstorm does not auto-create deep-interview / ralplan runtime state.",
		continueDecision: "Continue exploring before approval.",
		stopDecision: "Stop / no implementation.",
		advisorSection: "External Advisor Inputs",
		advisorNotRequested: "Not requested",
		advisorPending: "Requested, but no advisor artifact has been recorded yet.",
		advisorSucceeded: "Succeeded",
		advisorFailed: "Failed",
		advisorArtifactLabel: "Artifact",
		advisorSummaryLabel: "Summary",
		advisorErrorLabel: "Error",
		advisorExitCodeLabel: "Exit code",
		approvedRecommendationLabel: "Approved recommendation",
		suggestedNextCommandLabel: "Suggested next command",
		handoffDecisionLabel: "Handoff Decision",
		nextActionsHeading: "Next Actions",
		recommendedActionLabel: "Recommended action",
		continueActionLabel: "Continue this brainstorm",
		deepInterviewActionLabel: "Approve for deep-interview",
		ralplanActionLabel: "Approve for ralplan",
		stopActionLabel: "Stop",
		likelyTouchedModulesHeading: "Likely Touched Modules",
		relatedWorkflowsHeading: "Existing Related Workflows",
		repoConstraintsHeading: "Current Repo Constraints",
	};
}

function approvalDecisionText(
	approvalState: BrainstormApprovalState,
	lang: ResolvedBrainstormLanguage,
): string {
	const copy = localizedCopy(lang);
	switch (approvalState) {
		case "approved_for_deep_interview":
			return lang === "zh-CN" || lang === "zh-TW"
				? "已批准，下一步交给 deep-interview。"
				: "Approved for deep-interview.";
		case "approved_for_ralplan":
			return lang === "zh-CN" || lang === "zh-TW"
				? "已批准，下一步交给 ralplan。"
				: "Approved for ralplan.";
		case "continue_exploring":
			return copy.continueDecision;
		case "stopped":
			return copy.stopDecision;
		default:
			return lang === "zh-CN" || lang === "zh-TW"
				? "草稿已生成，等待确认。"
				: "Draft recorded and awaiting confirmation.";
	}
}

function suggestedNextCommand(
	approvalState: BrainstormApprovalState,
	artifactRelativePath: string,
	idea: string,
	slug: string,
): string {
	const safeIdea = oneLine(idea).replace(/"/g, '\\"');
	switch (approvalState) {
		case "approved_for_deep_interview":
			return `$deep-interview "Clarify the approved brainstorm direction from ${artifactRelativePath}: ${safeIdea}"`;
		case "approved_for_ralplan":
			return `$ralplan --from-design ${artifactRelativePath} "Turn the approved brainstorm direction into a PRD and test spec"`;
		case "continue_exploring":
			return `omx brainstorm resume --slug ${slug}`;
		default:
			return "No follow-up command approved.";
	}
}

function visibleLabeledLine(
	lang: ResolvedBrainstormLanguage,
	englishLabel: string,
	localizedLabel: string,
	value: string,
): string {
	if (!isChineseBrainstormLanguage(lang)) {
		return `${englishLabel}: ${value}`;
	}
	return `<!-- ${englishLabel}: ${value} -->\n${localizedLabel}：${value}`;
}

function approvedRecommendationLine(
	lang: ResolvedBrainstormLanguage,
	value: string,
): string {
	const copy = localizedCopy(lang);
	return visibleLabeledLine(
		lang,
		"Approved recommendation",
		copy.approvedRecommendationLabel,
		value,
	);
}

function suggestedNextCommandLine(
	lang: ResolvedBrainstormLanguage,
	value: string,
): string {
	const copy = localizedCopy(lang);
	return visibleLabeledLine(
		lang,
		"Suggested next command",
		copy.suggestedNextCommandLabel,
		value,
	);
}

function handoffDecisionLine(
	lang: ResolvedBrainstormLanguage,
	value: string,
): string {
	const copy = localizedCopy(lang);
	return visibleLabeledLine(
		lang,
		"Handoff Decision",
		copy.handoffDecisionLabel,
		value,
	);
}

interface BrainstormNextAction {
	label: string;
	command: string;
	recommended: boolean;
}

function brainstormNextActions(input: {
	approvalState: BrainstormApprovalState;
	artifactRelativePath: string;
	idea: string;
	slug: string;
	lang: ResolvedBrainstormLanguage;
}): BrainstormNextAction[] {
	const copy = localizedCopy(input.lang);
	return [
		{
			label: copy.continueActionLabel,
			command: `omx brainstorm resume --slug ${input.slug}`,
			recommended:
				input.approvalState === "draft" ||
				input.approvalState === "continue_exploring",
		},
		{
			label: copy.deepInterviewActionLabel,
			command: suggestedNextCommand(
				"approved_for_deep_interview",
				input.artifactRelativePath,
				input.idea,
				input.slug,
			),
			recommended: input.approvalState === "approved_for_deep_interview",
		},
		{
			label: copy.ralplanActionLabel,
			command: suggestedNextCommand(
				"approved_for_ralplan",
				input.artifactRelativePath,
				input.idea,
				input.slug,
			),
			recommended: input.approvalState === "approved_for_ralplan",
		},
		{
			label: copy.stopActionLabel,
			command: suggestedNextCommand(
				"stopped",
				input.artifactRelativePath,
				input.idea,
				input.slug,
			),
			recommended: input.approvalState === "stopped",
		},
	];
}

function buildNextActionsSection(input: {
	compileTarget: BrainstormDraftCompileTarget;
	artifactRelativePath: string;
	approvalState: BrainstormApprovalState;
}): string[] {
	const copy = localizedCopy(input.compileTarget.lang);
	const recommendedPrefix = isChineseBrainstormLanguage(input.compileTarget.lang)
		? `${copy.recommendedActionLabel}：`
		: `${copy.recommendedActionLabel}: `;
	const actions = brainstormNextActions({
		approvalState: input.approvalState,
		artifactRelativePath: input.artifactRelativePath,
		idea: input.compileTarget.idea,
		slug: input.compileTarget.slug,
		lang: input.compileTarget.lang,
	});

	return [
		`### ${copy.nextActionsHeading}`,
		...actions.map((action) =>
			`- ${action.recommended ? recommendedPrefix : ""}${action.label} -> ${action.command}`,
		),
	];
}

function artifactContractValue(value: string | number | null | undefined): string {
	if (value == null) return "none";
	const normalized = String(value).trim();
	return normalized || "none";
}

function maybeRelativeOmxPath(repoRoot: string, path: string | null): string | null {
	if (!path) return null;
	if (
		path.startsWith(".omx/") ||
		path.startsWith("./.omx/") ||
		(!path.includes("\\") && !path.includes(":"))
	) {
		return path.replace(/\\/g, "/").replace(/^\.\//, "");
	}
	return relativeOmxPath(repoRoot, path);
}

function localizedAdvisorStatus(
	run: BrainstormAdvisorRun,
	lang: ResolvedBrainstormLanguage,
): string {
	const copy = localizedCopy(lang);
	if (!run.enabled) return copy.advisorNotRequested;
	if (run.status === "succeeded") return copy.advisorSucceeded;
	if (run.status === "failed") return copy.advisorFailed;
	return copy.advisorPending;
}

function advisorDetailFallback(
	run: BrainstormAdvisorRun,
	lang: ResolvedBrainstormLanguage,
): string {
	const copy = localizedCopy(lang);
	if (!run.enabled) return copy.advisorNotRequested;
	if (run.status === "pending") return copy.advisorPending;
	if (run.status === "failed") {
		return run.summary ?? run.error ?? copy.advisorFailed;
	}
	return copy.advisorSucceeded;
}

function localizedAdvisorVisibleSummary(
	provider: BrainstormAdvisorProvider,
	run: BrainstormAdvisorRun,
	lang: ResolvedBrainstormLanguage,
): string {
	const copy = localizedCopy(lang);
	const summary = run.summary?.trim();
	if (!summary) return advisorDetailFallback(run, lang);
	if (summary === "Advisor not requested.") {
		return copy.advisorNotRequested;
	}
	if (
		summary === `Advisor ${provider} requested, but no artifact was recorded yet.`
	) {
		return copy.advisorPending;
	}
	return summary;
}

function stripAfterMarkerList(value: string, markers: readonly string[]): string {
	const normalized = cleanSectionText(value);
	if (!normalized) return "";
	let bestIndex = normalized.length;
	for (const marker of markers) {
		const index = normalized.indexOf(marker);
		if (index >= 0 && index < bestIndex) {
			bestIndex = index;
		}
	}
	return cleanSectionText(normalized.slice(0, bestIndex));
}

function joinParagraphs(parts: Array<string | null | undefined>): string {
	return parts
		.map((value) => cleanSectionText(value ?? ""))
		.filter(Boolean)
		.join("\n\n");
}

function dedupeLines(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = oneLine(value).toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(value.trim());
	}
	return result;
}

function bulletize(values: readonly string[]): string {
	return values.map((value) => `- ${value}`).join("\n");
}

function summarizeAdvisorEvidence(
	run: BrainstormAdvisorRun,
	provider: BrainstormAdvisorProvider,
): string {
	return (
		run.summary?.trim() ||
		`${sentenceCaseProvider(provider)} provided additional direction.`
	);
}

function successfulAdvisorEvidence(
	advisorRuns: BrainstormAdvisorRuns,
): Array<{
	provider: BrainstormAdvisorProvider;
	summary: string;
	actionItems: string[];
}> {
	return BRAINSTORM_ADVISOR_PROVIDERS.flatMap((provider) => {
		const run = advisorRuns[provider];
		if (!run.enabled || run.status !== "succeeded" || !run.artifactPath) {
			return [];
		}
		return [
			{
				provider,
				summary: summarizeAdvisorEvidence(run, provider),
				actionItems: run.actionItems,
			},
		];
	});
}

function defaultRenderedSections(
	compileTarget: BrainstormDraftCompileTarget,
): BrainstormRenderedSections {
	const copy = localizedCopy(compileTarget.lang);
	return {
		currentUnderstanding:
			compileTarget.desiredOutcome || copy.currentUnderstanding,
		goals: joinParagraphs([
			bulletize([compileTarget.desiredOutcome]),
			copy.goals,
		]),
		constraints: compileTarget.constraints || copy.constraintsFallback,
		openQuestions: compileTarget.openQuestions || copy.openQuestionsFallback,
		candidateSolutions: copy.candidateSolutions,
		recommendation: approvedRecommendationLine(
			compileTarget.lang,
			copy.recommendation,
		),
		risks: copy.risks,
		testing: copy.testing,
	};
}

function buildAdvisorAwareSections(
	compileTarget: BrainstormDraftCompileTarget,
	advisorRuns: BrainstormAdvisorRuns,
): BrainstormRenderedSections {
	const defaults = defaultRenderedSections(compileTarget);
	const evidence = successfulAdvisorEvidence(advisorRuns);
	if (evidence.length === 0) return defaults;

	const providerSummaries = evidence.map(
		(entry) => `${sentenceCaseProvider(entry.provider)}: ${entry.summary}`,
	);
	const actionItems = dedupeLines(
		evidence.flatMap((entry) =>
			entry.actionItems.map(
				(item) => `${sentenceCaseProvider(entry.provider)} follow-up: ${item}`,
			),
		),
	);

	if (compileTarget.lang === "zh-CN" || compileTarget.lang === "zh-TW") {
		const consensusText =
			evidence.length >= 2
				? "顾问共识：两位顾问都认为当前方向需要在进入下游流程前，把关键权衡、风险和验证路径写得更明确。"
				: "顾问判断：当前方向已经具备继续细化的价值，但应先把关键取舍写进主报告。";
		const divergenceText =
			evidence.length >= 2
				? `主要分歧/强调点：\n${bulletize(providerSummaries)}`
				: `外部顾问重点：\n${bulletize(providerSummaries)}`;

		return {
			currentUnderstanding: joinParagraphs([
				compileTarget.desiredOutcome,
				consensusText,
				divergenceText,
			]),
			goals: joinParagraphs([
				bulletize(
					dedupeLines([
						compileTarget.desiredOutcome,
						"把顾问建议整合进主结论，而不是只保留在附录。",
						evidence.length >= 2
							? "明确记录顾问共识、分歧以及人工决策点。"
							: "把单个顾问的关键建议转成可验证的设计目标。",
					]),
				),
			]),
			constraints: joinParagraphs([
				compileTarget.constraints || localizedCopy(compileTarget.lang).constraintsFallback,
				"新增顾问约束：",
				bulletize(providerSummaries),
			]),
			openQuestions: joinParagraphs([
				compileTarget.openQuestions || localizedCopy(compileTarget.lang).openQuestionsFallback,
				actionItems.length > 0
					? "顾问要求继续确认的问题：\n" + bulletize(actionItems)
					: null,
			]),
			candidateSolutions: joinParagraphs([
				"顾问驱动的候选方向：",
				bulletize(providerSummaries),
				evidence.length >= 2
					? "- 共识方向：先沿两位顾问都支持的主线收敛，再把分歧点留给 deep-interview 或 ralplan。"
					: "- 推荐先围绕该顾问强调的方向收敛，并用现有约束筛掉不合适方案。",
			]),
			recommendation: joinParagraphs([
				approvedRecommendationLine(
					compileTarget.lang,
					evidence.length >= 2
						? "优先采用顾问共识覆盖的主方向，同时把各自强调的差异点显式纳入后续澄清与规划。"
						: "优先采用成功顾问强化过的方向，并在进入下游流程前补足验证项。",
				),
				"支撑证据：",
				bulletize(providerSummaries),
			]),
			risks: joinParagraphs([
				"顾问提示的主要风险：",
				bulletize(providerSummaries),
				actionItems.length > 0
					? "缓解动作：\n" + bulletize(actionItems)
					: null,
			]),
			testing: joinParagraphs([
				"除原有 artifact/state 校验外，还应验证：",
				bulletize(
					dedupeLines([
						...providerSummaries.map(
							(summary) => `验证该顾问建议是否与仓库现状一致：${summary}`,
						),
						...actionItems,
					]),
				),
			]),
		};
	}

	const consensusText =
		evidence.length >= 2
			? "Advisor consensus: both successful advisors indicate that the direction should enter downstream workflows only after the trade-offs, risks, and validation steps are explicit in the main report."
			: "Advisor readout: the current direction is viable, but the main report should absorb the advisor-backed trade-offs before approval.";
	const divergenceText =
		evidence.length >= 2
			? `Primary differences in emphasis:\n${bulletize(providerSummaries)}`
			: `Primary advisor emphasis:\n${bulletize(providerSummaries)}`;

	return {
		currentUnderstanding: joinParagraphs([
			compileTarget.desiredOutcome,
			consensusText,
			divergenceText,
		]),
		goals: bulletize(
			dedupeLines([
				compileTarget.desiredOutcome,
				"Fold successful advisor evidence into the core report instead of leaving it as appendix-only input.",
				evidence.length >= 2
					? "Capture advisor consensus, advisor-specific emphasis, and the human decision points that remain."
					: "Turn the successful advisor guidance into explicit design goals and follow-up checks.",
			]),
		),
		constraints: joinParagraphs([
			compileTarget.constraints || localizedCopy(compileTarget.lang).constraintsFallback,
			"Advisor-informed constraints:",
			bulletize(providerSummaries),
		]),
		openQuestions: joinParagraphs([
			compileTarget.openQuestions || localizedCopy(compileTarget.lang).openQuestionsFallback,
			actionItems.length > 0
				? "Advisor follow-up questions:\n" + bulletize(actionItems)
				: null,
		]),
		candidateSolutions: joinParagraphs([
			"Advisor-informed candidate directions:",
			bulletize(providerSummaries),
			evidence.length >= 2
				? "- Consensus direction: follow the overlap between both advisors first, then carry the differences forward as explicit decision points."
				: "- Default direction: converge on the successful advisor's emphasis first, then validate it against the recorded constraints.",
		]),
		recommendation: joinParagraphs([
			approvedRecommendationLine(
				compileTarget.lang,
				evidence.length >= 2
					? "Prefer the shared direction supported by both advisors, then resolve provider-specific differences during deep-interview or ralplan."
					: "Prefer the direction reinforced by the successful advisor, then verify the remaining assumptions before approval.",
			),
			"Supporting evidence:",
			bulletize(providerSummaries),
		]),
		risks: joinParagraphs([
			"Advisor-raised risks:",
			bulletize(providerSummaries),
			actionItems.length > 0
				? "Mitigations and follow-up checks:\n" + bulletize(actionItems)
				: null,
		]),
		testing: joinParagraphs([
			"Beyond the normal artifact/state checks, validate:",
			bulletize(
				dedupeLines([
					...providerSummaries.map(
						(summary) =>
							`Confirm the repo/runtime still supports this advisor-backed claim: ${summary}`,
					),
					...actionItems,
				]),
			),
		]),
	};
}

function buildAdvisorSection(
	compileTarget: BrainstormDraftCompileTarget,
	advisorRuns: BrainstormAdvisorRuns,
): string[] {
	const copy = localizedCopy(compileTarget.lang);
	const lines = [`## 17. ${copy.advisorSection}`];
	for (const provider of BRAINSTORM_ADVISOR_PROVIDERS) {
		const run = advisorRuns[provider];
		const artifactPath = maybeRelativeOmxPath(
			compileTarget.repoRoot,
			run.artifactPath,
		);
		lines.push(`- ${provider}: ${localizedAdvisorStatus(run, compileTarget.lang)}`);
		lines.push(
			`  - ${copy.advisorArtifactLabel}: ${artifactPath ?? advisorDetailFallback(run, compileTarget.lang)}`,
		);
		lines.push(
			`  - ${copy.advisorExitCodeLabel}: ${run.exitCode ?? advisorDetailFallback(run, compileTarget.lang)}`,
		);
		lines.push(
			`  - ${copy.advisorSummaryLabel}: ${localizedAdvisorVisibleSummary(
				provider,
				run,
				compileTarget.lang,
			)}`,
		);
		if (run.error) {
			lines.push(`  - ${copy.advisorErrorLabel}: ${run.error}`);
		}
	}
	lines.push("");
	return lines;
}

function buildContextSnapshotContent(
	compileTarget: BrainstormDraftCompileTarget,
	repoContext: BrainstormRepoContext,
): string {
	const copy = localizedCopy(compileTarget.lang);
	return [
		"# Brainstorm Context Snapshot",
		"",
		`- slug: ${compileTarget.slug}`,
		`- lang: ${compileTarget.lang}`,
		`- idea: ${oneLine(compileTarget.idea)}`,
		`- desired outcome: ${oneLine(compileTarget.desiredOutcome)}`,
		"",
		"## Task Statement",
		compileTarget.idea,
		"",
		"## Desired Outcome",
		compileTarget.desiredOutcome,
		"",
		"## Known Facts / Evidence",
		"- Brainstorm CLI runtime is recording a reviewable draft artifact and stable handoff metadata.",
		"",
		"## Constraints",
		compileTarget.constraints || copy.constraintsFallback,
		"",
		"## Unknowns / Open Questions",
		compileTarget.openQuestions || copy.openQuestionsFallback,
		"",
		"## Likely Codebase Touchpoints",
		...repoContext.likelyTouchedModules.map(
			(entry) => `- ${entry.path} — ${entry.reason}`,
		),
		"",
		"## Existing Related Workflows",
		...repoContext.relatedWorkflows.map(
			(entry) => `- ${entry.name} — ${entry.summary}`,
		),
		"",
		"## Current Repo Constraints",
		...repoContext.currentRepoConstraints.map((entry) => `- ${entry}`),
		"",
	].join("\n");
}

async function latestContextSnapshotPath(
	repoRoot: string,
	slug: string,
): Promise<string | null> {
	const dir = contextDir(repoRoot);
	if (!existsSync(dir)) return null;
	const prefix = `${slug}-`;
	const entries = (await readdir(dir))
		.filter((file) => file.startsWith(prefix) && file.endsWith(".md"))
		.sort()
		.reverse();
	return entries[0] ? join(dir, entries[0]) : null;
}

export async function ensureBrainstormContextSnapshot(
	compileTarget: BrainstormDraftCompileTarget,
	repoContext: BrainstormRepoContext,
	now: Date = new Date(),
): Promise<string> {
	const dir = contextDir(compileTarget.repoRoot);
	await mkdir(dir, { recursive: true });
	const expectedContent = buildContextSnapshotContent(compileTarget, repoContext);

	const existing = await latestContextSnapshotPath(
		compileTarget.repoRoot,
		compileTarget.slug,
	);
	if (existing) {
		try {
			const currentContent = normalizeMarkdown(await readFile(existing, "utf-8"));
			if (currentContent === normalizeMarkdown(expectedContent)) {
				return existing;
			}
		} catch {
			// fall through and rewrite a fresh snapshot
		}
	}

	const filePath = join(
		dir,
		`${compileTarget.slug}-${compactUtcTimestamp(now)}.md`,
	);
	await writeFile(filePath, expectedContent, "utf-8");
	return filePath;
}

function buildArtifactPath(
	repoRoot: string,
	slug: string,
	timestamp: string,
): string {
	return join(specsDir(repoRoot), `brainstorm-${timestamp}-${slug}.md`);
}

function buildBrainstormReportContent(input: {
	compileTarget: BrainstormDraftCompileTarget;
	repoContext: BrainstormRepoContext;
	artifactPath: string;
	contextSnapshotPath: string;
	approvalState: BrainstormApprovalState;
	artifactWrittenAt: string;
	advisorRuns?: Partial<BrainstormAdvisorRuns> | null;
}): string {
	const { compileTarget, artifactPath, contextSnapshotPath, approvalState } =
		input;
	const copy = localizedCopy(compileTarget.lang);
	const artifactRelativePath = relativeOmxPath(
		compileTarget.repoRoot,
		artifactPath,
	);
	const contextRelativePath = relativeOmxPath(
		compileTarget.repoRoot,
		contextSnapshotPath,
	);
	const recommendedNextSkill =
		brainstormNextSkillForApprovalState(approvalState);
	const selectedNextSkill = selectedNextSkillForApprovalState(approvalState);
	const artifactStatus = artifactStatusForApprovalState(approvalState);
	const command = suggestedNextCommand(
		approvalState,
		artifactRelativePath,
		compileTarget.idea,
		compileTarget.slug,
	);
	const handoffDecision = approvalDecisionText(
		approvalState,
		compileTarget.lang,
	);
	const advisorRuns = normalizeBrainstormAdvisorRuns(
		compileTarget.advisorFlags,
		input.advisorRuns,
	);
	const renderedSections = buildAdvisorAwareSections(
		compileTarget,
		advisorRuns,
	);
	const nextActions = buildNextActionsSection({
		compileTarget,
		artifactRelativePath,
		approvalState,
	});

	return [
		`# Brainstorm Report: ${truncateTitle(compileTarget.idea)}`,
		"",
		"## 1. Original Idea",
		compileTarget.idea,
		"",
		"## 2. Current Understanding",
		renderedSections.currentUnderstanding,
		"",
		"## 3. Context Scan",
		`- Context snapshot: ${contextRelativePath}`,
		`- Language: ${compileTarget.lang}`,
		`- Advisor flags: claude=${String(compileTarget.advisorFlags.withClaude)}, gemini=${String(compileTarget.advisorFlags.withGemini)}`,
		"",
		`### ${copy.likelyTouchedModulesHeading}`,
		...input.repoContext.likelyTouchedModules.map(
			(entry) => `- ${entry.path} — ${entry.reason}`,
		),
		"",
		`### ${copy.relatedWorkflowsHeading}`,
		...input.repoContext.relatedWorkflows.map(
			(entry) => `- ${entry.name} — ${entry.summary}`,
		),
		"",
		`### ${copy.repoConstraintsHeading}`,
		...input.repoContext.currentRepoConstraints.map((entry) => `- ${entry}`),
		"",
		"## 4. Goals",
		renderedSections.goals,
		"",
		"## 5. Non-goals",
		copy.nonGoals,
		"",
		"## 6. Constraints",
		renderedSections.constraints,
		"",
		"## 7. Open Questions",
		renderedSections.openQuestions,
		"",
		"## 8. Candidate Solutions",
		renderedSections.candidateSolutions,
		"",
		"## 9. Recommendation",
		renderedSections.recommendation,
		"",
		"## 10. Proposed Workflow",
		copy.workflow,
		"",
		"## 11. Proposed Artifact Contract",
		copy.artifactContract,
		"",
		"## 12. Integration With Existing OMX Skills",
		copy.integration,
		"",
		"## 13. Risks and Mitigations",
		renderedSections.risks,
		"",
		"## 14. Testing Strategy",
		renderedSections.testing,
		"",
		"## 15. Ralplan Handoff",
		suggestedNextCommandLine(compileTarget.lang, command),
		`Recommended next skill: ${recommendedNextSkill}`,
		"",
		"## 16. Handoff Decision",
		handoffDecisionLine(compileTarget.lang, handoffDecision),
		`Approval state: ${approvalState}`,
		`Selected next skill: ${selectedNextSkill}`,
		`Context snapshot path: ${contextRelativePath}`,
		"",
		...nextActions,
		"",
		...buildAdvisorSection(compileTarget, advisorRuns),
		"artifact:",
		"  type: brainstorm_design_report",
		`  path: ${artifactRelativePath}`,
		`  status: ${artifactStatus}`,
		`  recommended_next_skill: ${recommendedNextSkill}`,
		`  selected_next_skill: ${selectedNextSkill}`,
		`  approval_state: ${approvalState}`,
		`  context_snapshot_path: ${contextRelativePath}`,
		`  lang: ${compileTarget.lang}`,
		`  artifact_written_at: ${input.artifactWrittenAt}`,
		`  raw_desired_outcome: ${artifactContractValue(compileTarget.desiredOutcome)}`,
		`  raw_constraints: ${artifactContractValue(compileTarget.constraints)}`,
		`  raw_open_questions: ${artifactContractValue(compileTarget.openQuestions)}`,
		...BRAINSTORM_ADVISOR_PROVIDERS.flatMap((provider) => {
			const run = advisorRuns[provider];
			return [
				`  advisor_${provider}_enabled: ${String(run.enabled)}`,
				`  advisor_${provider}_status: ${run.status}`,
				`  advisor_${provider}_artifact_path: ${artifactContractValue(
					maybeRelativeOmxPath(compileTarget.repoRoot, run.artifactPath),
				)}`,
				`  advisor_${provider}_exit_code: ${artifactContractValue(
					run.exitCode,
				)}`,
				`  advisor_${provider}_summary: ${artifactContractValue(run.summary)}`,
				`  advisor_${provider}_error: ${artifactContractValue(run.error)}`,
				`  advisor_${provider}_action_items: ${artifactContractValue(
					run.actionItems.length > 0 ? JSON.stringify(run.actionItems) : null,
				)}`,
			];
		}),
		"",
	].join("\n");
}

export async function writeBrainstormArtifact(input: {
	repoRoot: string;
	idea: string;
	desiredOutcome?: string;
	constraints?: string;
	openQuestions?: string;
	slug?: string;
	lang?: BrainstormLanguage;
	advisorFlags?: Partial<BrainstormAdvisorFlags>;
	advisorRuns?: Partial<BrainstormAdvisorRuns> | null;
	approvalState?: BrainstormApprovalState;
	forceNewArtifact?: boolean;
	now?: Date;
}): Promise<BrainstormArtifactDraft> {
	const idea = input.idea.trim();
	if (!idea) throw new Error("Brainstorm idea is required.");

	const slug = slugifyMissionName(input.slug?.trim() || idea);
	const lang = resolveBrainstormLanguage(input.lang, idea);
	const compileTarget: BrainstormDraftCompileTarget = {
		idea,
		desiredOutcome:
			input.desiredOutcome?.trim() || localizedCopy(lang).currentUnderstanding,
		constraints: input.constraints?.trim() || "",
		openQuestions: input.openQuestions?.trim() || "",
		slug,
		lang,
		repoRoot: input.repoRoot,
		advisorFlags: {
			withClaude: input.advisorFlags?.withClaude === true,
			withGemini: input.advisorFlags?.withGemini === true,
		},
	};
	const repoContext = await analyzeBrainstormRepoContext({
		repoRoot: input.repoRoot,
		idea,
		desiredOutcome: compileTarget.desiredOutcome,
		constraints: compileTarget.constraints,
		openQuestions: compileTarget.openQuestions,
	});

	const contextSnapshotPath = await ensureBrainstormContextSnapshot(
		compileTarget,
		repoContext,
		input.now,
	);
	const approvalState = input.approvalState ?? "draft";
	const nowStamp = compactUtcTimestamp(input.now);
	const artifactWrittenAt = (input.now ?? new Date()).toISOString();
	const latest = readLatestBrainstormArtifactForSlug(input.repoRoot, slug);
	const artifactPath =
		!input.forceNewArtifact && shouldReuseArtifact(latest)
			? latest!.path
			: buildArtifactPath(input.repoRoot, slug, nowStamp);

	await mkdir(specsDir(input.repoRoot), { recursive: true });
	const content = buildBrainstormReportContent({
		compileTarget,
		repoContext,
		artifactPath,
		contextSnapshotPath,
		approvalState,
		artifactWrittenAt,
		advisorRuns: input.advisorRuns,
	});
	await writeFile(artifactPath, content, "utf-8");
	const advisorRuns = normalizeBrainstormAdvisorRuns(
		compileTarget.advisorFlags,
		input.advisorRuns,
	);

	return {
		compileTarget,
		path: artifactPath,
		content,
		contextSnapshotPath,
		artifactWrittenAt,
		artifactStatus: artifactStatusForApprovalState(approvalState),
		approvalState,
		recommendedNextSkill: brainstormNextSkillForApprovalState(approvalState),
		selectedNextSkill: selectedNextSkillForApprovalState(approvalState),
		advisorRuns,
	};
}

function stateMatchesSelector(
	state: Record<string, unknown> | null,
	selector: { slug: string | null; latest: boolean },
	artifact: BrainstormArtifactRecord | null,
): boolean {
	if (!state) return false;
	const stateSlug = typeof state.slug === "string" ? state.slug.trim() : "";
	const stateArtifactPath =
		typeof state.brainstorm_artifact_path === "string"
			? state.brainstorm_artifact_path.replace(/\\/g, "/")
			: "";
	const stateArtifactWrittenAt =
		typeof state.artifact_written_at === "string"
			? state.artifact_written_at.trim()
			: "";
	const artifactWrittenAt = artifact?.artifactWrittenAt?.trim() ?? "";
	if (selector.slug) {
		if (artifact && stateArtifactPath) {
			return (
				stateArtifactPath === artifact.path.replace(/\\/g, "/") &&
				(!artifactWrittenAt ||
					!stateArtifactWrittenAt ||
					stateArtifactWrittenAt === artifactWrittenAt)
			);
		}
		return stateSlug === selector.slug;
	}
	if (artifact) {
		return (
			((stateArtifactPath === artifact.path.replace(/\\/g, "/") &&
				(!artifactWrittenAt ||
					!stateArtifactWrittenAt ||
					stateArtifactWrittenAt === artifactWrittenAt)) ||
			(!stateArtifactPath && stateSlug === artifact.slug)
			)
		);
	}
	return true;
}

function displayTitle(record: BrainstormArtifactRecord): string | null {
	return record.title?.replace(/^#\s+Brainstorm Report:\s*/i, "").trim() || null;
}

function legacyResumeDesiredOutcome(record: BrainstormArtifactRecord): string {
	return stripAfterMarkerList(record.currentUnderstandingSection, [
		"\n\nAdvisor readout:",
		"\n\nAdvisor consensus:",
		"\n\n顾问判断：",
		"\n\n顾问共识：",
	]);
}

function legacyResumeConstraints(record: BrainstormArtifactRecord): string {
	return stripAfterMarkerList(record.constraintsSection, [
		"\n\nAdvisor-informed constraints:",
		"\n\n新增顾问约束：",
	]);
}

function legacyResumeOpenQuestions(record: BrainstormArtifactRecord): string {
	return stripAfterMarkerList(record.openQuestionsSection, [
		"\n\nAdvisor follow-up questions:",
		"\n\n顾问要求继续确认的问题：",
	]);
}

function advisorFlagsFromRuns(
	advisorRuns: BrainstormAdvisorRuns | null,
): BrainstormAdvisorFlags {
	return {
		withClaude: advisorRuns?.claude.enabled === true,
		withGemini: advisorRuns?.gemini.enabled === true,
	};
}

function listItemFromRecord(
	record: BrainstormArtifactRecord,
	repoRoot: string,
): BrainstormArtifactListItem {
	return {
		slug: record.slug,
		timestamp: record.timestamp ?? null,
		title: displayTitle(record),
		artifactStatus: record.artifactStatus,
		approvalState: record.approvalState,
		recommendedNextSkill: record.recommendedNextSkill,
		artifactPath: relativeOmxPath(repoRoot, record.path),
	};
}

export function listBrainstormArtifacts(repoRoot: string): BrainstormListResult {
	return {
		items: [...readBrainstormArtifacts(repoRoot)]
			.reverse()
			.map((record) => listItemFromRecord(record, repoRoot)),
	};
}

export function readBrainstormHistory(
	repoRoot: string,
	slug: string,
): BrainstormHistoryResult {
	const normalizedSlug = slugifyMissionName(slug);
	return {
		slug: normalizedSlug,
		items: readBrainstormArtifactHistoryForSlug(repoRoot, normalizedSlug)
			.reverse()
			.map((record) => ({
				...listItemFromRecord(record, repoRoot),
				contextSnapshotPath: record.contextSnapshotPath,
				advisorFlags: advisorFlagsFromRuns(record.advisorRuns),
				advisorRuns: record.advisorRuns,
			})),
	};
}

export function resolveBrainstormResumeSeed(
	repoRoot: string,
	input: {
		slug: string;
		lang?: BrainstormLanguage;
		withClaude?: boolean;
		withGemini?: boolean;
	},
): BrainstormResumeSeed {
	const slug = slugifyMissionName(input.slug);
	const sourceArtifact = readLatestBrainstormArtifactForSlug(repoRoot, slug);
	if (!sourceArtifact) {
		throw new Error(`No brainstorm artifact found for slug "${slug}".`);
	}

	const idea =
		cleanSectionText(sourceArtifact.originalIdeaSection) ||
		displayTitle(sourceArtifact) ||
		sourceArtifact.slug;
	const note =
		sourceArtifact.approvalState === "approved_for_deep_interview" ||
		sourceArtifact.approvalState === "approved_for_ralplan"
			? "You are resuming from an approved brainstorm artifact. The resume flow will write a new latest draft version and keep the approved artifact unchanged."
			: null;

	return {
		sourceArtifact,
		seedInputs: {
			idea,
			slug,
			lang:
				input.lang ??
				(sourceArtifact.lang as BrainstormLanguage | null) ??
				"auto",
			withClaude: input.withClaude === true,
			withGemini: input.withGemini === true,
			desiredOutcome: (
				sourceArtifact.rawDesiredOutcome ??
				legacyResumeDesiredOutcome(sourceArtifact)
			) || idea,
			constraints:
				sourceArtifact.rawConstraints ??
				legacyResumeConstraints(sourceArtifact),
			openQuestions:
				sourceArtifact.rawOpenQuestions ??
				legacyResumeOpenQuestions(sourceArtifact),
		},
		note,
	};
}

export async function resolveBrainstormStatus(
	repoRoot: string,
	selector: { slug?: string; latest?: boolean } = {},
): Promise<BrainstormStatusResult> {
	const normalizedSelector = {
		slug: selector.slug?.trim() ? slugifyMissionName(selector.slug) : null,
		latest: selector.latest !== false,
	};
	const artifact = normalizedSelector.slug
		? readLatestBrainstormArtifactForSlug(repoRoot, normalizedSelector.slug)
		: readLatestBrainstormArtifact(repoRoot);

	const statePath = join(repoRoot, ".omx", "state", "brainstorm-state.json");
	let state: Record<string, unknown> | null = null;
	if (existsSync(statePath)) {
		try {
			state = JSON.parse(
				normalizeMarkdown(await readFile(statePath, "utf-8")),
			) as Record<string, unknown>;
		} catch {
			state = null;
		}
	}

	return {
		selector: normalizedSelector,
		artifact,
		state: stateMatchesSelector(state, normalizedSelector, artifact)
			? state
			: null,
	};
}
