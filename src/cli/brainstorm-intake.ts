import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { slugifyMissionName } from "../autoresearch/contracts.js";
import {
	BRAINSTORM_ADVISOR_PROVIDERS,
	BRAINSTORM_APPROVAL_STATES,
	BRAINSTORM_NEXT_SKILLS,
	type BrainstormApprovalState,
	type BrainstormAdvisorProvider,
	type BrainstormAdvisorRun,
	type BrainstormAdvisorRuns,
	type BrainstormArtifactRecord,
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
			},
		] as const satisfies readonly [BrainstormAdvisorProvider, BrainstormAdvisorRun];
	});

	return Object.fromEntries(entries) as BrainstormAdvisorRuns;
}

function normalizeMarkdown(content: string): string {
	return content.replace(/\r\n/g, "\n");
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
} {
	if (lang === "zh-CN" || lang === "zh-TW") {
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
			return `omx brainstorm init --slug ${slug} --idea "${safeIdea}"`;
		default:
			return "No follow-up command approved.";
	}
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
			`  - ${copy.advisorArtifactLabel}: ${artifactPath ?? copy.advisorNotRequested}`,
		);
		lines.push(
			`  - ${copy.advisorExitCodeLabel}: ${run.exitCode ?? copy.advisorNotRequested}`,
		);
		lines.push(
			`  - ${copy.advisorSummaryLabel}: ${run.summary ?? copy.advisorNotRequested}`,
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
		"- `.omx/context/` for snapshot reuse",
		"- `.omx/specs/brainstorm-<timestamp>-<slug>.md` for the canonical design artifact",
		"- `.omx/state/brainstorm-state.json` for brainstorm mode state",
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
	now: Date = new Date(),
): Promise<string> {
	const dir = contextDir(compileTarget.repoRoot);
	await mkdir(dir, { recursive: true });
	const expectedContent = buildContextSnapshotContent(compileTarget);

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

	return [
		`# Brainstorm Report: ${truncateTitle(compileTarget.idea)}`,
		"",
		"## 1. Original Idea",
		compileTarget.idea,
		"",
		"## 2. Current Understanding",
		compileTarget.desiredOutcome || copy.currentUnderstanding,
		"",
		"## 3. Context Scan",
		`- Context snapshot: ${contextRelativePath}`,
		`- Language: ${compileTarget.lang}`,
		`- Advisor flags: claude=${String(compileTarget.advisorFlags.withClaude)}, gemini=${String(compileTarget.advisorFlags.withGemini)}`,
		"",
		"## 4. Goals",
		`- ${compileTarget.desiredOutcome}`,
		copy.goals,
		"",
		"## 5. Non-goals",
		copy.nonGoals,
		"",
		"## 6. Constraints",
		compileTarget.constraints || copy.constraintsFallback,
		"",
		"## 7. Open Questions",
		compileTarget.openQuestions || copy.openQuestionsFallback,
		"",
		"## 8. Candidate Solutions",
		copy.candidateSolutions,
		"",
		"## 9. Recommendation",
		`Approved recommendation: ${copy.recommendation}`,
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
		copy.risks,
		"",
		"## 14. Testing Strategy",
		copy.testing,
		"",
		"## 15. Ralplan Handoff",
		`Suggested next command: ${command}`,
		`Recommended next skill: ${recommendedNextSkill}`,
		"",
		"## 16. Handoff Decision",
		`Handoff Decision: ${handoffDecision}`,
		`Approval state: ${approvalState}`,
		`Selected next skill: ${selectedNextSkill}`,
		`Context snapshot path: ${contextRelativePath}`,
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

	const contextSnapshotPath = await ensureBrainstormContextSnapshot(
		compileTarget,
		input.now,
	);
	const approvalState = input.approvalState ?? "draft";
	const nowStamp = compactUtcTimestamp(input.now);
	const artifactWrittenAt = (input.now ?? new Date()).toISOString();
	const latest = readLatestBrainstormArtifactForSlug(input.repoRoot, slug);
	const artifactPath = shouldReuseArtifact(latest)
		? latest!.path
		: buildArtifactPath(input.repoRoot, slug, nowStamp);

	await mkdir(specsDir(input.repoRoot), { recursive: true });
	const content = buildBrainstormReportContent({
		compileTarget,
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
