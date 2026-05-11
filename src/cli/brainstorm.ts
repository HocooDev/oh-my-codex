import {
	createResumedBrainstormDraft,
	createSeededBrainstormDraft,
	guidedBrainstormSetup,
	type InitBrainstormOptions,
	parseInitArgs,
	resumeBrainstormSetup,
} from "./brainstorm-guided.js";
import {
	type BrainstormAdvisorRuns,
	type BrainstormApprovalState,
	type BrainstormHistoryResult,
	type BrainstormLanguage,
	type BrainstormListResult,
	listBrainstormArtifacts,
	readBrainstormHistory,
	type BrainstormStatusResult,
	resolveBrainstormStatus,
	writeBrainstormArtifact,
} from "./brainstorm-intake.js";
import {
	diagnoseAllProviderAdvisors,
	type ProviderAdvisorDoctorSummary,
} from "./provider-advisor.js";
import { readLatestBrainstormArtifactForSlug } from "./brainstorm-intake.js";

export const BRAINSTORM_HELP = `omx brainstorm - Guided brainstorm artifact runtime

Usage:
  omx brainstorm
  omx brainstorm init [--idea <text>] [--slug <slug>] [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini] [--non-interactive]
  omx brainstorm resume --slug <slug> [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini] [--non-interactive]
  omx brainstorm approve --slug <slug> [--json]
  omx brainstorm list [--json]
  omx brainstorm history --slug <slug> [--json]
  omx brainstorm status [--slug <slug> | --latest] [--json]
  omx brainstorm doctor [--json]
  omx brainstorm --help

Notes:
  - \`omx brainstorm\` and \`omx brainstorm init\` are equivalent guided-entry forms.
  - This runtime writes/reuses brainstorm context + markdown artifacts and records handoff metadata only.
  - \`omx brainstorm resume\` always creates a new latest brainstorm artifact version for the slug.
  - \`omx brainstorm approve\` marks a draft brainstorm artifact as approved without entering the interactive guided flow.
  - \`omx brainstorm list\` and \`omx brainstorm history\` browse canonical markdown artifacts under \`.omx/specs/\`.
  - \`omx brainstorm doctor\` preflights the local Claude/Gemini advisor surfaces without writing a brainstorm artifact.
  - \`--non-interactive\` skips the guided TTY prompts and creates a seed draft directly (useful for CI and scripts).
  - \`--with-claude\` / \`--with-gemini\` run the corresponding local advisor CLI and save \`.omx/artifacts/ask-<provider>-...\` evidence.
  - Advisor failures are recorded and downgraded to warnings; they do not abort the brainstorm draft.
  - It does not auto-launch \`$deep-interview\`, \`$ralplan\`, \`$ralph\`, or \`$team\`.
`;

export interface ParsedBrainstormArgs {
	help?: boolean;
	guided?: boolean;
	initArgs?: string[];
	seedArgs?: Partial<InitBrainstormOptions>;
	resume?: boolean;
	resumeArgs?: string[];
	list?: boolean;
	listArgs?: string[];
	history?: boolean;
	historyArgs?: string[];
	status?: boolean;
	statusArgs?: string[];
	approve?: boolean;
	approveArgs?: string[];
	doctor?: boolean;
	doctorArgs?: string[];
}

export interface ParsedBrainstormStatusArgs {
	slug: string | null;
	latest: boolean;
	json: boolean;
	help?: boolean;
}

export interface ParsedBrainstormListArgs {
	json: boolean;
	help?: boolean;
}

export interface ParsedBrainstormHistoryArgs {
	slug: string | null;
	json: boolean;
	help?: boolean;
}

export interface ParsedBrainstormResumeArgs {
	slug: string | null;
	lang?: BrainstormLanguage;
	withClaude: boolean;
	withGemini: boolean;
	nonInteractive: boolean;
	help?: boolean;
}

export interface ParsedBrainstormApproveArgs {
	slug: string | null;
	json: boolean;
	help?: boolean;
}

export interface ParsedBrainstormDoctorArgs {
	json: boolean;
	help?: boolean;
}

function printAdvisorRuns(advisorRuns: BrainstormAdvisorRuns | undefined): void {
	if (!advisorRuns) return;
	for (const [provider, run] of Object.entries(advisorRuns)) {
		console.log(
			`Advisor ${provider}: ${run.status}${run.artifactPath ? ` (${run.artifactPath})` : ""}`,
		);
		if (run.error) {
			console.log(`Advisor ${provider} error: ${run.error}`);
		}
	}
}

function localizedAdvisorRunText(
	provider: string,
	run: {
		enabled: boolean;
		status: string;
		summary: string | null;
		error: string | null;
		artifactPath: string | null;
	},
	lang: string | null | undefined,
): { status: string; summary: string | null; errorLabel: string } {
	if (!isChineseDisplayLanguage(lang)) {
		return {
			status: run.status,
			summary: run.summary,
			errorLabel: `Advisor ${provider} error`,
		};
	}

	const status =
		run.enabled === false
			? "未请求"
			: run.status === "succeeded"
				? "成功"
				: run.status === "failed"
					? "失败"
					: "处理中";
	const summary =
		run.summary === "Advisor not requested."
			? "未请求"
			: run.summary ===
				  `Advisor ${provider} requested, but no artifact was recorded yet.`
				? "已请求，但尚未记录顾问产物。"
				: run.summary;
	return {
		status,
		summary,
		errorLabel: `顾问 ${provider} 错误`,
	};
}

function printAdvisorRunsLocalized(
	advisorRuns: BrainstormAdvisorRuns | undefined,
	lang: string | null | undefined,
): void {
	if (!advisorRuns) return;
	for (const [provider, run] of Object.entries(advisorRuns)) {
		const localized = localizedAdvisorRunText(provider, run, lang);
		console.log(
			`Advisor ${provider}: ${localized.status}${run.artifactPath ? ` (${run.artifactPath})` : ""}`,
		);
		if (localized.summary && localized.summary !== localized.status) {
			console.log(`Advisor ${provider} summary: ${localized.summary}`);
		}
		if (run.error) {
			console.log(`${localized.errorLabel}: ${run.error}`);
		}
	}
}

function isChineseDisplayLanguage(lang: string | null | undefined): boolean {
	return lang === "zh-CN" || lang === "zh-TW";
}

function resolveDoctorDisplayLanguage(): BrainstormLanguage {
	const locale = `${process.env.LC_ALL ?? ""} ${process.env.LANG ?? ""}`.toLowerCase();
	return locale.includes("zh") ? "zh-CN" : "en";
}

function cliCopy(lang: string | null | undefined): {
	statusLabel: string;
	artifactLabel: string;
	slugLabel: string;
	artifactStatusLabel: string;
	recommendedNextSkillLabel: string;
	selectedNextSkillLabel: string;
	contextSnapshotLabel: string;
	statePathLabel: string;
	modePhaseLabel: string;
	noDownstreamLaunch: string;
	nextActionsHeading: string;
	recommendedPrefix: string;
	continueLabel: string;
	deepInterviewLabel: string;
	ralplanLabel: string;
	stopLabel: string;
	brainstormArtifactLabel: string;
	approvalStateLabel: string;
	advisorHeading: string;
	doctorSummaryLabel: string;
	binaryLabel: string;
	scriptLabel: string;
	nextStepsLabel: string;
	readyLabel: string;
	notReadyLabel: string;
} {
	if (isChineseDisplayLanguage(lang)) {
		return {
			statusLabel: "Brainstorm 状态",
			artifactLabel: "产物",
			slugLabel: "Slug",
			artifactStatusLabel: "产物状态",
			recommendedNextSkillLabel: "推荐下一技能",
			selectedNextSkillLabel: "已选择下一技能",
			contextSnapshotLabel: "上下文快照",
			statePathLabel: "状态路径",
			modePhaseLabel: "模式阶段",
			noDownstreamLaunch: "未自动启动任何下游工作流。",
			nextActionsHeading: "下一步操作",
			recommendedPrefix: "推荐",
			continueLabel: "继续这一轮 brainstorm",
			deepInterviewLabel: "批准交给 deep-interview",
			ralplanLabel: "批准交给 ralplan",
			stopLabel: "停止",
			brainstormArtifactLabel: "Brainstorm 产物",
			approvalStateLabel: "审批状态",
			advisorHeading: "顾问检查",
			doctorSummaryLabel: "诊断摘要",
			binaryLabel: "Binary",
			scriptLabel: "Script override",
			nextStepsLabel: "建议下一步",
			readyLabel: "就绪",
			notReadyLabel: "未就绪",
		};
	}

	return {
		statusLabel: "Brainstorm status",
		artifactLabel: "Artifact",
		slugLabel: "Slug",
		artifactStatusLabel: "Artifact status",
		recommendedNextSkillLabel: "Recommended next skill",
		selectedNextSkillLabel: "Selected next skill",
		contextSnapshotLabel: "Context snapshot",
		statePathLabel: "State path",
		modePhaseLabel: "Mode phase",
		noDownstreamLaunch: "No downstream workflow was auto-launched.",
		nextActionsHeading: "Next actions",
		recommendedPrefix: "Recommended",
		continueLabel: "Continue this brainstorm",
		deepInterviewLabel: "Approve for deep-interview",
		ralplanLabel: "Approve for ralplan",
		stopLabel: "Stop",
		brainstormArtifactLabel: "Brainstorm artifact",
		approvalStateLabel: "Approval state",
		advisorHeading: "Advisor doctor",
		doctorSummaryLabel: "Summary",
		binaryLabel: "Binary",
		scriptLabel: "Script override",
		nextStepsLabel: "Next steps",
		readyLabel: "ready",
		notReadyLabel: "not ready",
	};
}

function deriveSuggestedCommands(artifact: BrainstormStatusResult["artifact"]): {
	continueCommand: string;
	deepInterviewCommand: string;
	ralplanCommand: string;
	stopCommand: string;
} {
	const artifactPath =
		artifact?.artifactPath ??
		artifact?.path?.replace(/\\/g, "/") ??
		".omx/specs/brainstorm-<timestamp>-<slug>.md";
	const slug = artifact?.slug ?? "<slug>";
	const idea = artifact?.originalIdeaSection?.trim().replace(/\s+/g, " ") || slug;
	return {
		continueCommand: `omx brainstorm resume --slug ${slug}`,
		deepInterviewCommand: `$deep-interview "Clarify the approved brainstorm direction from ${artifactPath}: ${idea.replace(/"/g, '\\"')}"`,
		ralplanCommand: `$ralplan --from-design ${artifactPath} "Turn the approved brainstorm direction into a PRD and test spec"`,
		stopCommand: "No follow-up command approved.",
	};
}

function printNextActions(artifact: BrainstormStatusResult["artifact"]): void {
	if (!artifact) return;
	const copy = cliCopy(artifact.lang);
	const commands = deriveSuggestedCommands(artifact);
	const recommended = artifact.approvalState ?? "draft";
	const actions = [
		{
			label: copy.continueLabel,
			command: commands.continueCommand,
			recommended: recommended === "draft" || recommended === "continue_exploring",
		},
		{
			label: copy.deepInterviewLabel,
			command: commands.deepInterviewCommand,
			recommended: recommended === "approved_for_deep_interview",
		},
		{
			label: copy.ralplanLabel,
			command: commands.ralplanCommand,
			recommended: recommended === "approved_for_ralplan",
		},
		{
			label: copy.stopLabel,
			command: commands.stopCommand,
			recommended: recommended === "stopped",
		},
	];
	console.log(`${copy.nextActionsHeading}:`);
	const recommendedPrefix = isChineseDisplayLanguage(artifact.lang)
		? `${copy.recommendedPrefix}：`
		: `${copy.recommendedPrefix}: `;
	for (const action of actions) {
		console.log(
			`- ${action.recommended ? recommendedPrefix : ""}${action.label} -> ${action.command}`,
		);
	}
}

function printDoctorSummary(
	report: ProviderAdvisorDoctorSummary,
	lang: BrainstormLanguage = "en",
): void {
	const copy = cliCopy(lang);
	const providerValues = Object.values(report.providers);
	const readyCount = providerValues.filter((provider) => provider.ready).length;
	const summary = isChineseDisplayLanguage(lang)
		? `${readyCount}/${providerValues.length} 个 brainstorm 顾问 provider 已就绪。`
		: report.summary;
	console.log(`${copy.doctorSummaryLabel}: ${summary}`);
	for (const provider of Object.keys(report.providers) as Array<keyof typeof report.providers>) {
		const item = report.providers[provider];
		const itemSummary = isChineseDisplayLanguage(lang)
			? item.script.overridden
				? item.script.ready
					? item.binary.ready
						? "script override 与 provider binary 都可用。"
						: "script override 可用，但 binary 检查失败。"
					: "script override 已配置，但目标文件不存在。"
				: item.binary.ready
					? "provider binary 可执行。"
					: "provider binary 当前不可执行。"
			: item.summary;
		console.log(
			`${provider}: ${item.ready ? copy.readyLabel : copy.notReadyLabel} — ${itemSummary}`,
		);
		console.log(`  ${copy.binaryLabel}: ${item.binary.configured ?? "none"}`);
		console.log(`  ${copy.scriptLabel}: ${item.script.configured ?? "none"}`);
		if (item.binary.summary) {
			console.log(`  ${copy.binaryLabel} summary: ${item.binary.summary}`);
		}
		if (item.script.overridden) {
			console.log(`  ${copy.scriptLabel} summary: ${item.script.summary}`);
		}
	}
	const nextSteps = isChineseDisplayLanguage(lang)
		? providerValues.flatMap((item) => {
				const localized: string[] = [];
				if (item.script.overridden && !item.script.ready) {
					localized.push(`修复或移除 ${item.provider} 的 script override：${item.script.configured}`);
				}
				if (!item.binary.ready) {
					localized.push(`运行 ${item.binary.verifyCommand ?? `${item.binary.configured ?? item.provider} --version`}，并修复输出中的 CLI / 认证问题。`);
				}
				if (item.script.overridden && item.script.ready) {
					localized.push(`确认 ${item.provider} 的 script override 指向 ${item.script.resolved}。`);
				}
				return localized;
			})
		: report.nextSteps;
	if (nextSteps.length > 0) {
		console.log(`${copy.nextStepsLabel}:`);
		for (const step of [...new Set(nextSteps)]) {
			console.log(`- ${step}`);
		}
	}
}

function shouldShowHelp(args: readonly string[]): boolean {
	return (
		args.length > 0 &&
		args.every((arg) => arg === "--help" || arg === "-h" || arg === "help")
	);
}

export function parseBrainstormArgs(
	args: readonly string[],
): ParsedBrainstormArgs {
	const values = [...args];
	if (values.length === 0) {
		return { guided: true };
	}

	const first = values[0]!;
	if (first === "--help" || first === "-h" || first === "help") {
		return { help: true };
	}
	if (first === "status") {
		return { status: true, statusArgs: values.slice(1) };
	}
	if (first === "resume") {
		return { resume: true, resumeArgs: values.slice(1) };
	}
	if (first === "list") {
		return { list: true, listArgs: values.slice(1) };
	}
	if (first === "history") {
		return { history: true, historyArgs: values.slice(1) };
	}
	if (first === "doctor") {
		return { doctor: true, doctorArgs: values.slice(1) };
	}
	if (first === "approve") {
		return { approve: true, approveArgs: values.slice(1) };
	}
	if (first === "init") {
		return {
			guided: true,
			initArgs: values.slice(1),
			seedArgs: parseInitArgs(values.slice(1)),
		};
	}
	return { guided: true, seedArgs: parseInitArgs(values) };
}

export function parseBrainstormDoctorArgs(
	args: readonly string[],
): ParsedBrainstormDoctorArgs {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { json, help: true };
		}
		throw new Error(`Unknown brainstorm doctor flag: ${arg.split("=")[0]}`);
	}
	return { json };
}

export function parseBrainstormStatusArgs(
	args: readonly string[],
): ParsedBrainstormStatusArgs {
	let slug: string | null = null;
	let latest = false;
	let json = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const next = args[index + 1];
		if (arg === "--slug") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --slug.");
			}
			slug = next.trim();
			index += 1;
			continue;
		}
		if (arg.startsWith("--slug=")) {
			slug = arg.slice("--slug=".length).trim();
			continue;
		}
		if (arg === "--latest") {
			latest = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { slug: null, latest: false, json, help: true };
		}
		throw new Error(`Unknown brainstorm status flag: ${arg.split("=")[0]}`);
	}

	if (slug && latest) {
		throw new Error("Use either --slug <slug> or --latest, not both.");
	}

	return {
		slug,
		latest: latest || !slug,
		json,
	};
}

export function parseBrainstormListArgs(
	args: readonly string[],
): ParsedBrainstormListArgs {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { json, help: true };
		}
		throw new Error(`Unknown brainstorm list flag: ${arg.split("=")[0]}`);
	}
	return { json };
}

export function parseBrainstormHistoryArgs(
	args: readonly string[],
): ParsedBrainstormHistoryArgs {
	let slug: string | null = null;
	let json = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const next = args[index + 1];
		if (arg === "--slug") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --slug.");
			}
			slug = next.trim();
			index += 1;
			continue;
		}
		if (arg.startsWith("--slug=")) {
			slug = arg.slice("--slug=".length).trim();
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { slug: null, json, help: true };
		}
		throw new Error(`Unknown brainstorm history flag: ${arg.split("=")[0]}`);
	}

	if (!slug) {
		throw new Error("Missing required --slug <slug>.");
	}

	return { slug, json };
}

export function parseBrainstormResumeArgs(
	args: readonly string[],
): ParsedBrainstormResumeArgs {
	let slug: string | null = null;
	let lang: BrainstormLanguage | undefined;
	let withClaude = false;
	let withGemini = false;
	let nonInteractive = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const next = args[index + 1];
		if (arg === "--slug") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --slug.");
			}
			slug = next.trim();
			index += 1;
			continue;
		}
		if (arg.startsWith("--slug=")) {
			slug = arg.slice("--slug=".length).trim();
			continue;
		}
		if (arg === "--lang") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --lang.");
			}
			if (!["auto", "en", "zh-CN", "zh-TW"].includes(next)) {
				throw new Error("--lang must be one of: auto, en, zh-CN, zh-TW");
			}
			lang = next as BrainstormLanguage;
			index += 1;
			continue;
		}
		if (arg.startsWith("--lang=")) {
			const value = arg.slice("--lang=".length);
			if (!["auto", "en", "zh-CN", "zh-TW"].includes(value)) {
				throw new Error("--lang must be one of: auto, en, zh-CN, zh-TW");
			}
			lang = value as BrainstormLanguage;
			continue;
		}
		if (arg === "--with-claude") {
			withClaude = true;
			continue;
		}
		if (arg === "--with-gemini") {
			withGemini = true;
			continue;
		}
		if (arg === "--non-interactive" || arg === "--quick") {
			nonInteractive = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { slug: null, lang, withClaude, withGemini, nonInteractive, help: true };
		}
		if (arg === "--latest") {
			throw new Error("Resume requires --slug <slug>; --latest is not supported.");
		}
		throw new Error(`Unknown brainstorm resume flag: ${arg.split("=")[0]}`);
	}

	if (!slug) {
		throw new Error("Missing required --slug <slug>.");
	}

	return { slug, lang, withClaude, withGemini, nonInteractive };
}

export function parseBrainstormApproveArgs(
	args: readonly string[],
): ParsedBrainstormApproveArgs {
	let slug: string | null = null;
	let json = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const next = args[index + 1];
		if (arg === "--slug") {
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --slug.");
			}
			slug = next.trim();
			index += 1;
			continue;
		}
		if (arg.startsWith("--slug=")) {
			slug = arg.slice("--slug=".length).trim();
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { slug: null, json, help: true };
		}
		throw new Error(`Unknown brainstorm approve flag: ${arg.split("=")[0]}`);
	}

	if (!slug) {
		throw new Error("Missing required --slug <slug>.");
	}

	return { slug, json };
}

function printHumanStatus(status: BrainstormStatusResult): void {
	if (!status.artifact && !status.state) {
		const selector = status.selector.slug
			? `slug "${status.selector.slug}"`
			: "latest brainstorm artifact";
		throw new Error(`No brainstorm status found for ${selector}.`);
	}

	const artifact = status.artifact;
	const state = status.state;
	const copy = cliCopy(artifact?.lang);
	console.log(
		`${copy.statusLabel}: ${state?.approval_state ?? artifact?.approvalState ?? "unknown"}`,
	);
	if (artifact) {
		console.log(`${copy.artifactLabel}: ${artifact.path}`);
		console.log(`${copy.slugLabel}: ${artifact.slug}`);
		console.log(`${copy.artifactStatusLabel}: ${artifact.artifactStatus ?? "unknown"}`);
		console.log(
			`${copy.recommendedNextSkillLabel}: ${artifact.recommendedNextSkill ?? "none"}`,
		);
		console.log(`${copy.selectedNextSkillLabel}: ${artifact.selectedNextSkill ?? "none"}`);
		if (artifact.contextSnapshotPath) {
			console.log(`${copy.contextSnapshotLabel}: ${artifact.contextSnapshotPath}`);
		}
	}
	if (state) {
		console.log(`${copy.statePathLabel}: .omx/state/brainstorm-state.json`);
		console.log(`${copy.modePhaseLabel}: ${String(state.current_phase ?? "unknown")}`);
	}
	const advisorRuns =
		(state?.advisor_runs as BrainstormAdvisorRuns | undefined) ??
		artifact?.advisorRuns ??
		undefined;
	printAdvisorRunsLocalized(advisorRuns, artifact?.lang);
	printNextActions(artifact);
}

function printHumanList(listResult: BrainstormListResult): void {
	if (listResult.items.length === 0) {
		console.log("No brainstorm artifacts found.");
		return;
	}
	for (const item of listResult.items) {
		console.log(
			`${item.timestamp ?? "unknown"}  ${item.slug}  ${item.artifactStatus ?? "unknown"}  ${item.approvalState ?? "unknown"}  ${item.recommendedNextSkill ?? "none"}`,
		);
		if (item.title) {
			console.log(`  Title: ${item.title}`);
		}
		console.log(`  Artifact: ${item.artifactPath}`);
	}
}

function printHumanHistory(historyResult: BrainstormHistoryResult): void {
	if (historyResult.items.length === 0) {
		console.log(`No brainstorm artifact history found for slug "${historyResult.slug}".`);
		return;
	}
	console.log(`Brainstorm history for slug "${historyResult.slug}":`);
	for (const item of historyResult.items) {
		console.log(
			`${item.timestamp ?? "unknown"}  ${item.artifactStatus ?? "unknown"}  ${item.approvalState ?? "unknown"}  ${item.recommendedNextSkill ?? "none"}`,
		);
		if (item.title) {
			console.log(`  Title: ${item.title}`);
		}
		console.log(`  Artifact: ${item.artifactPath}`);
		if (item.contextSnapshotPath) {
			console.log(`  Context snapshot: ${item.contextSnapshotPath}`);
		}
		console.log(
			`  Advisor flags: claude=${String(item.advisorFlags.withClaude)}, gemini=${String(item.advisorFlags.withGemini)}`,
		);
		printAdvisorRuns(item.advisorRuns ?? undefined);
	}
}

function normalizeSeedArgs(
	seedArgs: Partial<InitBrainstormOptions> | undefined,
): {
	idea?: string;
	slug?: string;
	lang?: BrainstormLanguage;
	withClaude?: boolean;
	withGemini?: boolean;
	nonInteractive?: boolean;
} {
	return {
		idea: seedArgs?.idea,
		slug: seedArgs?.slug,
		lang: seedArgs?.lang,
		withClaude: seedArgs?.withClaude,
		withGemini: seedArgs?.withGemini,
		nonInteractive: seedArgs?.nonInteractive,
	};
}

async function printDraftResult(input: {
	slug: string;
	brainstormArtifactPath: string;
	approvalState: string;
	selectedNextSkill: string;
	advisorRuns: BrainstormAdvisorRuns;
}): Promise<void> {
	const status = await resolveBrainstormStatus(process.cwd(), {
		slug: input.slug,
		latest: false,
	});
	const copy = cliCopy(status.artifact?.lang);
	console.log(`${copy.brainstormArtifactLabel}: ${input.brainstormArtifactPath}`);
	console.log(`${copy.approvalStateLabel}: ${input.approvalState}`);
	console.log(`${copy.selectedNextSkillLabel}: ${input.selectedNextSkill}`);
	printAdvisorRunsLocalized(input.advisorRuns, status.artifact?.lang);
	printNextActions(status.artifact);
	console.log(copy.noDownstreamLaunch);
}

export async function brainstormCommand(args: string[]): Promise<void> {
	if (shouldShowHelp(args)) {
		console.log(BRAINSTORM_HELP);
		return;
	}

	const parsed = parseBrainstormArgs(args);
	if (parsed.help) {
		console.log(BRAINSTORM_HELP);
		return;
	}

	if (parsed.status) {
		const statusArgs = parseBrainstormStatusArgs(parsed.statusArgs ?? []);
		if (statusArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}
		const status = await resolveBrainstormStatus(process.cwd(), {
			slug: statusArgs.slug ?? undefined,
			latest: statusArgs.latest,
		});
		if (statusArgs.json) {
			console.log(JSON.stringify(status, null, 2));
			return;
		}
		printHumanStatus(status);
		return;
	}

	if (parsed.doctor) {
		const doctorArgs = parseBrainstormDoctorArgs(parsed.doctorArgs ?? []);
		if (doctorArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}
		const report = await diagnoseAllProviderAdvisors({
			cwd: process.cwd(),
			env: process.env,
		});
		if (doctorArgs.json) {
			console.log(JSON.stringify(report, null, 2));
			return;
		}
		printDoctorSummary(report, resolveDoctorDisplayLanguage());
		return;
	}

	if (parsed.list) {
		const listArgs = parseBrainstormListArgs(parsed.listArgs ?? []);
		if (listArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}
		const result = listBrainstormArtifacts(process.cwd());
		if (listArgs.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		printHumanList(result);
		return;
	}

	if (parsed.history) {
		const historyArgs = parseBrainstormHistoryArgs(parsed.historyArgs ?? []);
		if (historyArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}
		const result = readBrainstormHistory(process.cwd(), historyArgs.slug ?? "");
		if (historyArgs.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		printHumanHistory(result);
		return;
	}

	if (parsed.resume) {
		const resumeArgs = parseBrainstormResumeArgs(parsed.resumeArgs ?? []);
		if (resumeArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}

		const resumeInput = {
			slug: resumeArgs.slug ?? "",
			lang: resumeArgs.lang,
			withClaude: resumeArgs.withClaude,
			withGemini: resumeArgs.withGemini,
		};
		const isNonInteractive = !process.stdin.isTTY || resumeArgs.nonInteractive;
		const result = isNonInteractive
			? await createResumedBrainstormDraft(process.cwd(), resumeInput)
			: await resumeBrainstormSetup(process.cwd(), resumeInput);
		if (result.resumeNote) {
			console.log(result.resumeNote);
		}
		if (result.resumedFromArtifactPath) {
			console.log(`Resumed from: ${result.resumedFromArtifactPath}`);
		}
		await printDraftResult({
			slug: result.slug,
			brainstormArtifactPath: result.brainstormArtifactPath,
			approvalState: result.approvalState,
			selectedNextSkill: result.selectedNextSkill,
			advisorRuns: result.advisorRuns,
		});
		return;
	}

	if (parsed.approve) {
		const approveArgs = parseBrainstormApproveArgs(parsed.approveArgs ?? []);
		if (approveArgs.help) {
			console.log(BRAINSTORM_HELP);
			return;
		}
		const slug = approveArgs.slug ?? "";
		const existing = readLatestBrainstormArtifactForSlug(process.cwd(), slug);
		if (!existing) {
			throw new Error(`No brainstorm artifact found for slug "${slug}".`);
		}
		const idea = existing.originalIdeaSection?.trim() || existing.title?.replace(/^#+\s*Brainstorm Report:\s*/i, "").trim() || slug;
		const result = await writeBrainstormArtifact({
			repoRoot: process.cwd(),
			idea,
			slug,
			desiredOutcome: existing.currentUnderstandingSection?.trim(),
			constraints: existing.constraintsSection?.trim(),
			openQuestions: existing.openQuestionsSection?.trim(),
			advisorFlags: {
				withClaude: existing.advisorRuns?.claude.enabled === true,
				withGemini: existing.advisorRuns?.gemini.enabled === true,
			},
			advisorRuns: existing.advisorRuns,
			approvalState: "approved_for_ralplan",
			forceNewArtifact: true,
		});
		if (approveArgs.json) {
			console.log(
				JSON.stringify(
					{
						slug: result.compileTarget.slug,
						artifactPath: result.path,
						approvalState: result.approvalState,
						recommendedNextSkill: result.recommendedNextSkill,
						selectedNextSkill: result.selectedNextSkill,
						artifactStatus: result.artifactStatus,
					},
					null,
					2,
				),
			);
			return;
		}
		await printDraftResult({
			slug: result.compileTarget.slug,
			brainstormArtifactPath: result.path,
			approvalState: result.approvalState,
			selectedNextSkill: result.selectedNextSkill,
			advisorRuns: result.advisorRuns,
		});
		return;
	}

	if (!parsed.guided) {
		console.log(BRAINSTORM_HELP);
		return;
	}

	if (!process.stdin.isTTY || parsed.seedArgs?.nonInteractive) {
		const seedArgs = normalizeSeedArgs(parsed.seedArgs);
		if (!seedArgs.idea?.trim()) {
			throw new Error(
				"Guided brainstorm setup requires an interactive terminal unless `--idea` is provided to seed a draft artifact.",
			);
		}
		const result = await createSeededBrainstormDraft(process.cwd(), seedArgs);
		await printDraftResult({
			slug: result.slug,
			brainstormArtifactPath: result.brainstormArtifactPath,
			approvalState: result.approvalState,
			selectedNextSkill: result.selectedNextSkill,
			advisorRuns: result.advisorRuns,
		});
		return;
	}

	const result = await guidedBrainstormSetup(
		process.cwd(),
		normalizeSeedArgs(parsed.seedArgs),
	);
	await printDraftResult({
		slug: result.slug,
		brainstormArtifactPath: result.brainstormArtifactPath,
		approvalState: result.approvalState,
		selectedNextSkill: result.selectedNextSkill,
		advisorRuns: result.advisorRuns,
	});
}
