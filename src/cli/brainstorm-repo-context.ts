import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const IGNORED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".omx",
	"node_modules",
	"dist",
	"coverage",
	"target",
	".next",
	".turbo",
]);

const TEXT_FILE_EXTENSIONS = new Set([
	".cjs",
	".cpp",
	".css",
	".go",
	".h",
	".hpp",
	".html",
	".java",
	".js",
	".json",
	".md",
	".mjs",
	".ps1",
	".py",
	".rb",
	".rs",
	".sh",
	".toml",
	".ts",
	".tsx",
	".txt",
	".yaml",
	".yml",
]);

const STOP_WORDS = new Set([
	"about",
	"after",
	"against",
	"also",
	"and",
	"artifact",
	"artifacts",
	"before",
	"being",
	"between",
	"brainstorming",
	"build",
	"change",
	"changes",
	"check",
	"current",
	"direction",
	"from",
	"have",
	"idea",
	"into",
	"just",
	"keep",
	"later",
	"main",
	"make",
	"more",
	"need",
	"next",
	"none",
	"only",
	"plan",
	"report",
	"runtime",
	"should",
	"that",
	"then",
	"this",
	"with",
	"workflow",
]);

const WORKFLOW_HINTS = [
	{
		name: "brainstorm",
		summary:
			"Artifact-first design exploration via `omx brainstorm` before downstream approval.",
		terms: ["brainstorm", "design", "draft", "explore"],
	},
	{
		name: "deep-interview",
		summary:
			"Requirements-clarification handoff when the artifact still has open questions.",
		terms: ["question", "questions", "clarify", "clarification", "requirements"],
	},
	{
		name: "ralplan",
		summary:
			"Planning handoff that turns an approved design artifact into PRD/test-spec outputs.",
		terms: ["plan", "planning", "prd", "spec", "test", "handoff"],
	},
	{
		name: "advisor inputs",
		summary:
			"Optional Claude/Gemini advisor lane for extra design readouts without auto-launching execution.",
		terms: ["claude", "gemini", "advisor", "provider", "doctor"],
	},
] as const;

export interface BrainstormRepoTouchpoint {
	path: string;
	reason: string;
	score: number;
}

export interface BrainstormRepoWorkflowHint {
	name: string;
	summary: string;
}

export interface BrainstormRepoContext {
	likelyTouchedModules: BrainstormRepoTouchpoint[];
	relatedWorkflows: BrainstormRepoWorkflowHint[];
	currentRepoConstraints: string[];
}

function relativePath(repoRoot: string, path: string): string {
	return relative(repoRoot, path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function includeFile(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return TEXT_FILE_EXTENSIONS.has(extension) || extension === "";
}

function extractKeywords(raw: string): string[] {
	const keywords = new Set<string>();
	for (const token of raw.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,31}/g) ?? []) {
		if (!STOP_WORDS.has(token)) {
			keywords.add(token);
		}
	}

	const knownTerms = [
		"brainstorm",
		"doctor",
		"provider",
		"advisor",
		"claude",
		"gemini",
		"deep-interview",
		"ralplan",
		"localization",
		"locale",
		"language",
		"repo",
		"repository",
		"artifact",
		"state",
		"markdown",
		"status",
		"resume",
		"init",
	];
	for (const term of knownTerms) {
		if (raw.toLowerCase().includes(term)) {
			keywords.add(term);
		}
	}
	return [...keywords];
}

async function walkFiles(
	root: string,
	limit = 300,
): Promise<string[]> {
	const files: string[] = [];

	async function visit(current: string): Promise<void> {
		if (files.length >= limit) return;
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (files.length >= limit) return;
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					await visit(join(current, entry.name));
				}
				continue;
			}
			const nextPath = join(current, entry.name);
			if (includeFile(nextPath)) {
				files.push(nextPath);
			}
		}
	}

	await visit(root);
	return files;
}

function fallbackTouchpoints(repoRoot: string): BrainstormRepoTouchpoint[] {
	const defaults = ["README.md", "package.json", "tsconfig.json", "Cargo.toml"]
		.map((file) => join(repoRoot, file))
		.filter(existsSync)
		.map((path) => ({
			path: relativePath(repoRoot, path),
			reason: "fallback repo anchor",
			score: 1,
		}));

	return defaults.length > 0
		? defaults
		: [
				{
					path: ".omx/specs/",
					reason: "canonical brainstorm artifact destination",
					score: 1,
				},
			];
}

function buildRepoConstraints(repoRoot: string): string[] {
	const constraints: string[] = [];

	if (existsSync(join(repoRoot, "package.json"))) {
		constraints.push(
			"`package.json` present — preserve Node/npm entrypoints and script expectations.",
		);
	}
	if (existsSync(join(repoRoot, "tsconfig.json"))) {
		constraints.push(
			"`tsconfig.json` present — TypeScript compile health is part of the repo contract.",
		);
	}
	if (existsSync(join(repoRoot, "Cargo.toml"))) {
		constraints.push(
			"`Cargo.toml` present — Rust-side build/runtime compatibility may be part of the change surface.",
		);
	}
	if (existsSync(join(repoRoot, ".git"))) {
		constraints.push(
			"Git workspace detected — reviewable, path-stable diffs are expected over ad hoc generated output.",
		);
	}

	constraints.push(
		"Brainstorm runtime stays artifact-first: canonical markdown lives under `.omx/specs/` and state stays paired in `.omx/state/brainstorm-state.json`.",
	);
	constraints.push(
		"Downstream workflows remain explicit handoffs only — brainstorm records the next skill but does not auto-launch it.",
	);

	return constraints.slice(0, 5);
}

export async function analyzeBrainstormRepoContext(input: {
	repoRoot: string;
	idea: string;
	desiredOutcome: string;
	constraints: string;
	openQuestions: string;
}): Promise<BrainstormRepoContext> {
	const rawQuery = [
		input.idea,
		input.desiredOutcome,
		input.constraints,
		input.openQuestions,
	].join("\n");
	const keywords = extractKeywords(rawQuery);
	const files = await walkFiles(input.repoRoot);
	const scored: BrainstormRepoTouchpoint[] = [];
	const workflowScores = new Map<string, number>();
	for (const workflow of WORKFLOW_HINTS) {
		workflowScores.set(workflow.name, workflow.name === "brainstorm" ? 1 : 0);
	}

	for (const file of files) {
		const pathText = relativePath(input.repoRoot, file);
		const pathLower = pathText.toLowerCase();
		let content = "";
		try {
			content = (await readFile(file, "utf-8")).slice(0, 12_000).toLowerCase();
		} catch {
			continue;
		}

		let score = 0;
		const matched: string[] = [];
		for (const keyword of keywords) {
			if (pathLower.includes(keyword)) {
				score += keyword.includes("-") ? 5 : 4;
				matched.push(keyword);
				continue;
			}
			if (content.includes(keyword)) {
				score += 2;
				matched.push(keyword);
			}
		}

		for (const workflow of WORKFLOW_HINTS) {
			let workflowScore = workflowScores.get(workflow.name) ?? 0;
			for (const term of workflow.terms) {
				if (pathLower.includes(term)) {
					workflowScore += 2;
				}
				if (content.includes(term)) {
					workflowScore += 1;
				}
			}
			workflowScores.set(workflow.name, workflowScore);
		}

		if (score <= 0) continue;
		scored.push({
			path: pathText,
			reason: `matches: ${[...new Set(matched)].slice(0, 4).join(", ")}`,
			score,
		});
	}

	scored.sort(
		(left, right) =>
			right.score - left.score || left.path.localeCompare(right.path),
	);

	const likelyTouchedModules =
		scored
			.filter(
				(entry, index, list) =>
					list.findIndex((candidate) => candidate.path === entry.path) === index,
			)
			.slice(0, 5) || [];

	const relatedWorkflows = WORKFLOW_HINTS.map((workflow) => ({
		workflow,
		score:
			(workflowScores.get(workflow.name) ?? 0) +
			workflow.terms.reduce(
				(total, term) => total + (rawQuery.toLowerCase().includes(term) ? 1 : 0),
				0,
			),
	}))
		.filter((entry) => entry.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.workflow.name.localeCompare(right.workflow.name),
		)
		.slice(0, 4)
		.map((entry) => ({
			name: entry.workflow.name,
			summary: entry.workflow.summary,
		}));

	return {
		likelyTouchedModules:
			likelyTouchedModules.length > 0
				? likelyTouchedModules
				: fallbackTouchpoints(input.repoRoot),
		relatedWorkflows:
			relatedWorkflows.length > 0
				? relatedWorkflows
				: [
						{
							name: "brainstorm",
							summary:
								"Continue using the canonical brainstorm artifact as the coordination surface until a downstream handoff is approved.",
						},
					],
		currentRepoConstraints: buildRepoConstraints(input.repoRoot),
	};
}
