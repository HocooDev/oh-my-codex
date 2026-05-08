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
	type BrainstormHistoryResult,
	type BrainstormLanguage,
	type BrainstormListResult,
	listBrainstormArtifacts,
	readBrainstormHistory,
	type BrainstormStatusResult,
	resolveBrainstormStatus,
} from "./brainstorm-intake.js";

export const BRAINSTORM_HELP = `omx brainstorm - Guided brainstorm artifact runtime

Usage:
  omx brainstorm
  omx brainstorm init [--idea <text>] [--slug <slug>] [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini]
  omx brainstorm resume --slug <slug> [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini]
  omx brainstorm list [--json]
  omx brainstorm history --slug <slug> [--json]
  omx brainstorm status [--slug <slug> | --latest] [--json]
  omx brainstorm --help

Notes:
  - \`omx brainstorm\` and \`omx brainstorm init\` are equivalent guided-entry forms.
  - This runtime writes/reuses brainstorm context + markdown artifacts and records handoff metadata only.
  - \`omx brainstorm resume\` always creates a new latest brainstorm artifact version for the slug.
  - \`omx brainstorm list\` and \`omx brainstorm history\` browse canonical markdown artifacts under \`.omx/specs/\`.
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
	if (first === "init") {
		return {
			guided: true,
			initArgs: values.slice(1),
			seedArgs: parseInitArgs(values.slice(1)),
		};
	}
	return { guided: true, seedArgs: parseInitArgs(values) };
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
		if (arg === "--help" || arg === "-h" || arg === "help") {
			return { slug: null, lang, withClaude, withGemini, help: true };
		}
		if (arg === "--latest") {
			throw new Error("Resume requires --slug <slug>; --latest is not supported.");
		}
		throw new Error(`Unknown brainstorm resume flag: ${arg.split("=")[0]}`);
	}

	if (!slug) {
		throw new Error("Missing required --slug <slug>.");
	}

	return { slug, lang, withClaude, withGemini };
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
	console.log(
		`Brainstorm status: ${state?.approval_state ?? artifact?.approvalState ?? "unknown"}`,
	);
	if (artifact) {
		console.log(`Artifact: ${artifact.path}`);
		console.log(`Slug: ${artifact.slug}`);
		console.log(`Artifact status: ${artifact.artifactStatus ?? "unknown"}`);
		console.log(
			`Recommended next skill: ${artifact.recommendedNextSkill ?? "none"}`,
		);
		console.log(`Selected next skill: ${artifact.selectedNextSkill ?? "none"}`);
		if (artifact.contextSnapshotPath) {
			console.log(`Context snapshot: ${artifact.contextSnapshotPath}`);
		}
	}
	if (state) {
		console.log(`State path: .omx/state/brainstorm-state.json`);
		console.log(`Mode phase: ${String(state.current_phase ?? "unknown")}`);
	}
	const advisorRuns =
		(state?.advisor_runs as BrainstormAdvisorRuns | undefined) ??
		artifact?.advisorRuns ??
		undefined;
	printAdvisorRuns(advisorRuns);
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
} {
	return {
		idea: seedArgs?.idea,
		slug: seedArgs?.slug,
		lang: seedArgs?.lang,
		withClaude: seedArgs?.withClaude,
		withGemini: seedArgs?.withGemini,
	};
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
		const result = !process.stdin.isTTY
			? await createResumedBrainstormDraft(process.cwd(), resumeInput)
			: await resumeBrainstormSetup(process.cwd(), resumeInput);
		if (result.resumeNote) {
			console.log(result.resumeNote);
		}
		if (result.resumedFromArtifactPath) {
			console.log(`Resumed from: ${result.resumedFromArtifactPath}`);
		}
		console.log(`Brainstorm artifact: ${result.brainstormArtifactPath}`);
		console.log(`Approval state: ${result.approvalState}`);
		console.log(`Selected next skill: ${result.selectedNextSkill}`);
		printAdvisorRuns(result.advisorRuns);
		console.log("No downstream workflow was auto-launched.");
		return;
	}

	if (!parsed.guided) {
		console.log(BRAINSTORM_HELP);
		return;
	}

	if (!process.stdin.isTTY) {
		const seedArgs = normalizeSeedArgs(parsed.seedArgs);
		if (!seedArgs.idea?.trim()) {
			throw new Error(
				"Guided brainstorm setup requires an interactive terminal unless `--idea` is provided to seed a draft artifact.",
			);
		}
		const result = await createSeededBrainstormDraft(process.cwd(), seedArgs);
		console.log(`Brainstorm artifact: ${result.brainstormArtifactPath}`);
		console.log(`Approval state: ${result.approvalState}`);
		console.log(`Selected next skill: ${result.selectedNextSkill}`);
		printAdvisorRuns(result.advisorRuns);
		console.log("No downstream workflow was auto-launched.");
		return;
	}

	const result = await guidedBrainstormSetup(
		process.cwd(),
		normalizeSeedArgs(parsed.seedArgs),
	);
	console.log(`Brainstorm artifact: ${result.brainstormArtifactPath}`);
	console.log(`Approval state: ${result.approvalState}`);
	console.log(`Selected next skill: ${result.selectedNextSkill}`);
	printAdvisorRuns(result.advisorRuns);
	console.log("No downstream workflow was auto-launched.");
}
