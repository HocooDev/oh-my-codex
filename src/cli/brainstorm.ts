import {
	createSeededBrainstormDraft,
	guidedBrainstormSetup,
	type InitBrainstormOptions,
	parseInitArgs,
} from "./brainstorm-guided.js";
import {
	type BrainstormAdvisorRuns,
	type BrainstormLanguage,
	type BrainstormStatusResult,
	resolveBrainstormStatus,
} from "./brainstorm-intake.js";

export const BRAINSTORM_HELP = `omx brainstorm - Guided brainstorm artifact runtime

Usage:
  omx brainstorm
  omx brainstorm init [--idea <text>] [--slug <slug>] [--lang <auto|en|zh-CN|zh-TW>] [--with-claude] [--with-gemini]
  omx brainstorm status [--slug <slug> | --latest] [--json]
  omx brainstorm --help

Notes:
  - \`omx brainstorm\` and \`omx brainstorm init\` are equivalent guided-entry forms.
  - This runtime writes/reuses brainstorm context + markdown artifacts and records handoff metadata only.
  - \`--with-claude\` / \`--with-gemini\` run the corresponding local advisor CLI and save \`.omx/artifacts/ask-<provider>-...\` evidence.
  - Advisor failures are recorded and downgraded to warnings; they do not abort the brainstorm draft.
  - It does not auto-launch \`$deep-interview\`, \`$ralplan\`, \`$ralph\`, or \`$team\`.
`;

export interface ParsedBrainstormArgs {
	help?: boolean;
	guided?: boolean;
	initArgs?: string[];
	seedArgs?: Partial<InitBrainstormOptions>;
	status?: boolean;
	statusArgs?: string[];
}

export interface ParsedBrainstormStatusArgs {
	slug: string | null;
	latest: boolean;
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
