import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import { omxPlansDir } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;
const BRAINSTORM_SPEC_PATTERN = /^brainstorm-.*\.md$/i;
const APPROVED_REPOSITORY_CONTEXT_MAX_CHARS = 4_000;
const APPROVED_REPOSITORY_CONTEXT_MAX_LINES = 80;

export const BRAINSTORM_NEXT_SKILLS = ['deep-interview', 'ralplan', 'none'] as const;
export type BrainstormRecommendedNextSkill = (typeof BRAINSTORM_NEXT_SKILLS)[number];
export type BrainstormSelectedNextSkill = BrainstormRecommendedNextSkill;

export const BRAINSTORM_APPROVAL_STATES = [
  'draft',
  'continue_exploring',
  'approved_for_deep_interview',
  'approved_for_ralplan',
  'stopped',
] as const;
export type BrainstormApprovalState = (typeof BRAINSTORM_APPROVAL_STATES)[number];

export const BRAINSTORM_ADVISOR_PROVIDERS = ['claude', 'gemini'] as const;
export type BrainstormAdvisorProvider = (typeof BRAINSTORM_ADVISOR_PROVIDERS)[number];

export const BRAINSTORM_ADVISOR_RUN_STATUSES = ['pending', 'skipped', 'succeeded', 'failed'] as const;
export type BrainstormAdvisorRunStatus = (typeof BRAINSTORM_ADVISOR_RUN_STATUSES)[number];

export interface BrainstormAdvisorRun {
  enabled: boolean;
  status: BrainstormAdvisorRunStatus;
  artifactPath: string | null;
  exitCode: number | null;
  summary: string | null;
  error: string | null;
  actionItems: string[];
}

export type BrainstormAdvisorRuns = Record<BrainstormAdvisorProvider, BrainstormAdvisorRun>;

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  brainstormPaths: string[];
}

export interface ApprovedRepositoryContextSummary {
  sourcePath: string;
  content: string;
  truncated: boolean;
}

export interface ApprovedPlanContext {
  sourcePath: string;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  repositoryContextSummary?: ApprovedRepositoryContextSummary;
}

export interface ApprovedExecutionLaunchHint extends ApprovedPlanContext {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
}

export interface LatestPlanningArtifactSelection {
  prdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
}

interface ApprovedExecutionLaunchHintReadOptions {
  prdPath?: string;
  task?: string;
  command?: string;
}

export type ApprovedExecutionLaunchHintOutcome =
  | { status: 'absent' }
  | { status: 'ambiguous' }
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint };

export interface TeamDagArtifactResolution {
  source: 'json-sidecar' | 'markdown-handoff' | 'none';
  prdPath: string | null;
  planSlug: string | null;
  artifactPath?: string;
  content?: string;
  warnings: string[];
}

export interface BrainstormArtifactRecord {
  path: string;
  slug: string;
  timestamp?: string;
  content: string;
  title: string | null;
  originalIdeaSection: string;
  currentUnderstandingSection: string;
  goalsSection: string;
  constraintsSection: string;
  openQuestionsSection: string;
  candidateSolutionsSection: string;
  recommendationSection: string;
  ralplanHandoffSection: string;
  handoffDecisionSection: string;
  approvedRecommendation: string | null;
  suggestedNextCommand: string | null;
  handoffDecision: string | null;
  artifactType: string | null;
  artifactPath: string | null;
  artifactStatus: string | null;
  recommendedNextSkill: BrainstormRecommendedNextSkill | null;
  selectedNextSkill: BrainstormSelectedNextSkill | null;
  approvalState: BrainstormApprovalState | null;
  contextSnapshotPath: string | null;
  lang: string | null;
  artifactWrittenAt: string | null;
  rawDesiredOutcome: string | null;
  rawConstraints: string | null;
  rawOpenQuestions: string | null;
  advisorRuns: BrainstormAdvisorRuns | null;
  missingAnchors: string[];
}

function readMatchingPaths(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((file) => pattern.test(file))
      .sort(comparePlanningArtifactPaths)
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

function normalizeMarkdown(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function extractMarkdownSection(content: string, headingPattern: RegExp): string {
  const lines = normalizeMarkdown(content).split('\n');
  const headingIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (headingIndex < 0) return '';

  const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1].length ?? 1;
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const nextHeading = lines[index].match(/^(#{1,6})\s+/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    body.push(lines[index]);
  }
  return body.join('\n').trim();
}

function extractAnchoredValue(section: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^\\s*(?:-\\s*)?${escaped}:\\s*(.+?)\\s*$`, 'im'));
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  const commented = section.match(new RegExp(`<!--\\s*${escaped}:\\s*(.+?)\\s*-->`, 'i'));
  return commented?.[1]?.trim() || null;
}

function parseArtifactContract(content: string): {
  type: string | null;
  path: string | null;
  status: string | null;
  recommendedNextSkill: BrainstormRecommendedNextSkill | null;
  selectedNextSkill: BrainstormSelectedNextSkill | null;
  approvalState: BrainstormApprovalState | null;
  contextSnapshotPath: string | null;
  lang: string | null;
  artifactWrittenAt: string | null;
  rawDesiredOutcome: string | null;
  rawConstraints: string | null;
  rawOpenQuestions: string | null;
  advisorRuns: BrainstormAdvisorRuns | null;
} {
  const lines = normalizeMarkdown(content).split('\n');
  const start = lines.findIndex((line) => /^artifact:\s*$/i.test(line.trim()));
  if (start < 0) {
    return {
      type: null,
      path: null,
      status: null,
      recommendedNextSkill: null,
      selectedNextSkill: null,
      approvalState: null,
      contextSnapshotPath: null,
      lang: null,
      artifactWrittenAt: null,
      rawDesiredOutcome: null,
      rawConstraints: null,
      rawOpenQuestions: null,
      advisorRuns: null,
    };
  }

  const values: Record<string, string> = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+(?<key>[a-z_]+):\s*(?<value>.+?)\s*$/i);
    if (!match?.groups?.key || !match.groups.value) continue;
    values[match.groups.key.toLowerCase()] = match.groups.value.trim();
  }

  const recommendedNextSkill = values.recommended_next_skill?.trim().toLowerCase() ?? null;
  const selectedNextSkill = values.selected_next_skill?.trim().toLowerCase() ?? null;
  const approvalState = values.approval_state?.trim().toLowerCase() ?? null;
  const advisorRuns = parseBrainstormAdvisorRuns(values);
  return {
    type: values.type ?? null,
    path: values.path ?? null,
    status: values.status ?? null,
    recommendedNextSkill: BRAINSTORM_NEXT_SKILLS.includes(recommendedNextSkill as BrainstormRecommendedNextSkill)
      ? recommendedNextSkill as BrainstormRecommendedNextSkill
      : null,
    selectedNextSkill: BRAINSTORM_NEXT_SKILLS.includes(selectedNextSkill as BrainstormSelectedNextSkill)
      ? selectedNextSkill as BrainstormSelectedNextSkill
      : null,
    approvalState: BRAINSTORM_APPROVAL_STATES.includes(approvalState as BrainstormApprovalState)
      ? approvalState as BrainstormApprovalState
      : null,
    contextSnapshotPath: values.context_snapshot_path ?? null,
    lang: values.lang ?? null,
    artifactWrittenAt: values.artifact_written_at ?? null,
    rawDesiredOutcome: parseArtifactContractString(values.raw_desired_outcome),
    rawConstraints: parseArtifactContractString(values.raw_constraints),
    rawOpenQuestions: parseArtifactContractString(values.raw_open_questions),
    advisorRuns,
  };
}

function parseArtifactContractString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.toLowerCase() !== 'none' ? normalized : null;
}

function parseArtifactContractNumber(value: string | undefined): number | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'none') return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArtifactContractStringArray(value: string | undefined): string[] {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === 'none') return [];
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseArtifactContractBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function parseBrainstormAdvisorRuns(values: Record<string, string>): BrainstormAdvisorRuns | null {
  const hasAdvisorFields = Object.keys(values).some((key) => key.startsWith('advisor_'));
  if (!hasAdvisorFields) return null;

  const entries = BRAINSTORM_ADVISOR_PROVIDERS.map((provider) => {
    const enabled = parseArtifactContractBoolean(values[`advisor_${provider}_enabled`]) ?? false;
    const status = values[`advisor_${provider}_status`]?.trim().toLowerCase() ?? 'skipped';
    return [
      provider,
      {
        enabled,
        status: BRAINSTORM_ADVISOR_RUN_STATUSES.includes(status as BrainstormAdvisorRunStatus)
          ? status as BrainstormAdvisorRunStatus
          : 'skipped',
        artifactPath: parseArtifactContractString(values[`advisor_${provider}_artifact_path`]),
        exitCode: parseArtifactContractNumber(values[`advisor_${provider}_exit_code`]),
        summary: parseArtifactContractString(values[`advisor_${provider}_summary`]),
        error: parseArtifactContractString(values[`advisor_${provider}_error`]),
        actionItems: parseArtifactContractStringArray(values[`advisor_${provider}_action_items`]),
      },
    ] as const;
  });

  return Object.fromEntries(entries) as BrainstormAdvisorRuns;
}

function collectBrainstormMissingAnchors(record: Omit<BrainstormArtifactRecord, 'missingAnchors'>, cwd: string): string[] {
  const missing: string[] = [];
  if (!record.title || !/^#\s+Brainstorm Report:/i.test(record.title)) {
    missing.push('# Brainstorm Report:');
  }
  if (!record.recommendationSection) missing.push('## 9. Recommendation');
  if (!record.ralplanHandoffSection) missing.push('## 15. Ralplan Handoff');
  if (!record.handoffDecisionSection) missing.push('## 16. Handoff Decision');
  if (!record.approvedRecommendation) missing.push('Approved recommendation');
  if (!record.suggestedNextCommand) missing.push('Suggested next command');
  if (!record.handoffDecision) missing.push('Handoff Decision');
  if (record.artifactType !== 'brainstorm_design_report') missing.push('artifact.type = brainstorm_design_report');
  if (!record.artifactPath) {
    missing.push('artifact.path');
  } else {
    const declaredPath = record.artifactPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const actualRelativePath = relative(cwd, record.path).replace(/\\/g, '/');
    if (
      !/^\.omx\/specs\/brainstorm-.*\.md$/i.test(declaredPath)
      || declaredPath !== actualRelativePath
      || !isCanonicalBrainstormArtifactPath(record.path, cwd)
    ) {
      missing.push('artifact.path matches brainstorm artifact path');
    }
  }
  if (!record.recommendedNextSkill) missing.push('recommended_next_skill');
  return missing;
}

export function brainstormSpecsDir(cwd: string): string {
  return join(cwd, '.omx', 'specs');
}

export function isCanonicalBrainstormArtifactPath(reportPath: string, cwd = process.cwd()): boolean {
  const resolvedPath = resolve(cwd, reportPath);
  const specsDir = brainstormSpecsDir(cwd);
  const relativePath = relative(specsDir, resolvedPath);
  if (relativePath === '') return false;
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return false;
  return /^brainstorm-.*\.md$/i.test(basename(resolvedPath));
}

export function readBrainstormArtifact(reportPath: string, cwd = process.cwd()): BrainstormArtifactRecord | null {
  const resolvedPath = resolve(cwd, reportPath);
  const parsed = parsePlanningArtifactFileName(resolvedPath);
  if (parsed?.kind !== 'brainstorm' || !existsSync(resolvedPath) || !isCanonicalBrainstormArtifactPath(resolvedPath, cwd)) {
    return null;
  }

  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    const normalized = normalizeMarkdown(content);
    const title = normalized.match(/^#\s+Brainstorm Report:.*$/im)?.[0] ?? null;
    const originalIdeaSection = extractMarkdownSection(normalized, /^##\s+1\.\s+Original Idea\s*$/i);
    const currentUnderstandingSection = extractMarkdownSection(normalized, /^##\s+2\.\s+Current Understanding\s*$/i);
    const goalsSection = extractMarkdownSection(normalized, /^##\s+4\.\s+Goals\s*$/i);
    const constraintsSection = extractMarkdownSection(normalized, /^##\s+6\.\s+Constraints\s*$/i);
    const openQuestionsSection = extractMarkdownSection(normalized, /^##\s+7\.\s+Open Questions\s*$/i);
    const candidateSolutionsSection = extractMarkdownSection(normalized, /^##\s+8\.\s+Candidate Solutions\s*$/i);
    const recommendationSection = extractMarkdownSection(normalized, /^##\s+9\.\s+Recommendation\s*$/i);
    const ralplanHandoffSection = extractMarkdownSection(normalized, /^##\s+15\.\s+Ralplan Handoff\s*$/i);
    const handoffDecisionSection = extractMarkdownSection(normalized, /^##\s+16\.\s+Handoff Decision\s*$/i);
    const contract = parseArtifactContract(normalized);
    const recordWithoutMissing = {
      path: resolvedPath,
      slug: parsed.slug,
      timestamp: parsed.timestamp,
      content,
      title,
      originalIdeaSection,
      currentUnderstandingSection,
      goalsSection,
      constraintsSection,
      openQuestionsSection,
      candidateSolutionsSection,
      recommendationSection,
      ralplanHandoffSection,
      handoffDecisionSection,
      approvedRecommendation: extractAnchoredValue(recommendationSection, 'Approved recommendation'),
      suggestedNextCommand: extractAnchoredValue(ralplanHandoffSection, 'Suggested next command'),
      handoffDecision: extractAnchoredValue(handoffDecisionSection, 'Handoff Decision'),
      artifactType: contract.type,
      artifactPath: contract.path,
      artifactStatus: contract.status,
      recommendedNextSkill: contract.recommendedNextSkill,
      selectedNextSkill: contract.selectedNextSkill,
      approvalState: contract.approvalState,
      contextSnapshotPath: contract.contextSnapshotPath,
      lang: contract.lang,
      artifactWrittenAt: contract.artifactWrittenAt,
      rawDesiredOutcome: contract.rawDesiredOutcome,
      rawConstraints: contract.rawConstraints,
      rawOpenQuestions: contract.rawOpenQuestions,
      advisorRuns: contract.advisorRuns,
    };

    return {
      ...recordWithoutMissing,
      missingAnchors: collectBrainstormMissingAnchors(recordWithoutMissing, cwd),
    };
  } catch {
    return null;
  }
}

export function readBrainstormArtifacts(cwd: string): BrainstormArtifactRecord[] {
  return readPlanningArtifacts(cwd).brainstormPaths
    .map((path) => readBrainstormArtifact(path, cwd))
    .filter((record): record is BrainstormArtifactRecord => Boolean(record));
}

export function readBrainstormArtifactHistoryForSlug(cwd: string, slug: string): BrainstormArtifactRecord[] {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return [];
  return readPlanningArtifacts(cwd).brainstormPaths
    .filter((path) => planningArtifactSlug(path, 'brainstorm')?.toLowerCase() === normalizedSlug)
    .map((path) => readBrainstormArtifact(path, cwd))
    .filter((record): record is BrainstormArtifactRecord => Boolean(record));
}

export function readLatestBrainstormArtifact(cwd: string): BrainstormArtifactRecord | null {
  const latest = selectLatestPlanningArtifactPath(readPlanningArtifacts(cwd).brainstormPaths);
  return latest ? readBrainstormArtifact(latest, cwd) : null;
}

export function readLatestBrainstormArtifactForSlug(cwd: string, slug: string): BrainstormArtifactRecord | null {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return null;
  const brainstormPaths = readPlanningArtifacts(cwd).brainstormPaths;
  for (let index = brainstormPaths.length - 1; index >= 0; index -= 1) {
    const path = brainstormPaths[index]!;
    if (planningArtifactSlug(path, 'brainstorm')?.toLowerCase() !== normalizedSlug) {
      continue;
    }
    const record = readBrainstormArtifact(path, cwd);
    if (record) return record;
  }
  return null;
}

export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  const plansDir = omxPlansDir(cwd);
  const specsDir = brainstormSpecsDir(cwd);

  return {
    plansDir,
    specsDir,
    prdPaths: readMatchingPaths(plansDir, PRD_PATTERN),
    testSpecPaths: readMatchingPaths(plansDir, TEST_SPEC_PATTERN),
    deepInterviewSpecPaths: readMatchingPaths(specsDir, DEEP_INTERVIEW_SPEC_PATTERN)
      .filter((path) => parsePlanningArtifactFileName(path)?.kind === 'deep-interview'),
    brainstormPaths: readMatchingPaths(specsDir, BRAINSTORM_SPEC_PATTERN)
      .filter((path) => parsePlanningArtifactFileName(path)?.kind === 'brainstorm'),
  };
}

export function isPlanningComplete(artifacts: PlanningArtifacts): boolean {
  const selection = selectLatestPlanningArtifacts(artifacts);
  return Boolean(selection.prdPath) && selection.testSpecPaths.length > 0;
}

export function decodeApprovedExecutionQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1).replace(/\\'/g, "'");
  }
  return null;
}

function artifactPathSuffix(path: string, prefixPattern: RegExp): string | null {
  const file = basename(path);
  const match = file.match(prefixPattern);
  return match?.groups?.slug ?? null;
}

function selectDeepInterviewSpecPathsForSlug(paths: readonly string[], slug: string | null): string[] {
  if (!slug) return [];
  return paths
    .filter((path) => planningArtifactSlug(path, 'deep-interview') === slug)
    .sort(comparePlanningArtifactPaths);
}

function selectPlanningArtifacts(
  artifacts: PlanningArtifacts,
  prdPath?: string,
): LatestPlanningArtifactSelection {
  const selectedPrdPath = prdPath == null
    ? selectLatestPlanningArtifactPath(artifacts.prdPaths)
    : artifacts.prdPaths.includes(prdPath)
      ? prdPath
      : null;
  const slug = selectedPrdPath
    ? planningArtifactSlug(selectedPrdPath, 'prd')
    : null;

  return {
    prdPath: selectedPrdPath,
    testSpecPaths: selectMatchingTestSpecsForPrd(selectedPrdPath, artifacts.testSpecPaths),
    deepInterviewSpecPaths: selectDeepInterviewSpecPathsForSlug(artifacts.deepInterviewSpecPaths, slug),
  };
}

function boundedRepositoryContextSummary(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const normalizedLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  const trimmed = normalizedLines.join('\n').trim();
  if (!trimmed) return null;

  const limitedLines = normalizedLines.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_LINES);
  const lineTruncated = normalizedLines.length > limitedLines.length;
  let limited = limitedLines.join('\n').trim();
  let charTruncated = false;
  if (limited.length > APPROVED_REPOSITORY_CONTEXT_MAX_CHARS) {
    limited = limited.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_CHARS).trimEnd();
    charTruncated = true;
  }
  return { sourcePath, content: limited, truncated: lineTruncated || charTruncated };
}

function extractApprovedRepositoryContextSection(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Approved Repository Context Summary\s*$/i.test(line.trim()));
  if (headingIndex < 0) return null;
  const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1].length ?? 1;
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= headingLevel) break;
    body.push(lines[index]);
  }
  return boundedRepositoryContextSummary(sourcePath, body.join('\n'));
}

function readApprovedRepositoryContextSummary(
  artifacts: PlanningArtifacts,
  prdPath: string,
  planSlug: string | null,
  prdContent: string,
): ApprovedRepositoryContextSummary | null {
  if (!planSlug) return extractApprovedRepositoryContextSection(prdPath, prdContent);
  const sidecarPath = join(artifacts.plansDir, `repo-context-${planSlug}.md`);
  if (existsSync(sidecarPath)) {
    try {
      const sidecar = boundedRepositoryContextSummary(sidecarPath, readFileSync(sidecarPath, 'utf-8'));
      if (sidecar) return sidecar;
    } catch {
      // Fall through to an inline approved PRD section when the inspectable sidecar is unreadable.
    }
  }
  return extractApprovedRepositoryContextSection(prdPath, prdContent);
}

function readApprovedPlanText(
  cwd: string,
  options: ApprovedExecutionLaunchHintReadOptions = {},
): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (!isPlanningComplete(artifacts)) return null;

  const selection = selectPlanningArtifacts(artifacts, options.prdPath);
  const latestPrdPath = selection.prdPath;
  if (!latestPrdPath || selection.testSpecPaths.length === 0 || !existsSync(latestPrdPath)) return null;

  try {
    const content = readFileSync(latestPrdPath, 'utf-8');
    const planSlug = artifactPathSuffix(latestPrdPath, /^prd-(?<slug>.*)\.md$/i);
    const repositoryContextSummary = readApprovedRepositoryContextSummary(artifacts, latestPrdPath, planSlug, content);
    return {
      content,
      context: {
        sourcePath: latestPrdPath,
        testSpecPaths: selection.testSpecPaths,
        deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
        ...(repositoryContextSummary ? { repositoryContextSummary } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function selectLatestPlanningArtifacts(
  artifacts: PlanningArtifacts,
): LatestPlanningArtifactSelection {
  return selectPlanningArtifacts(artifacts);
}

export function readLatestPlanningArtifacts(cwd: string): LatestPlanningArtifactSelection {
  return selectLatestPlanningArtifacts(readPlanningArtifacts(cwd));
}

function extractTeamDagMarkdownHandoff(content: string): string | null {
  const fencePattern = /```(?:json)?\s*\n(?<body>[\s\S]*?)```/gi;
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const headingIndex = content.toLowerCase().indexOf('team dag handoff', searchFrom);
    if (headingIndex < 0) return null;
    fencePattern.lastIndex = headingIndex;
    const match = fencePattern.exec(content);
    if (match?.groups?.body) {
      return match.groups.body.trim();
    }
    searchFrom = headingIndex + 'team dag handoff'.length;
  }
  return null;
}

export function readTeamDagArtifactResolution(cwd: string): TeamDagArtifactResolution {
  const artifacts = readPlanningArtifacts(cwd);
  if (artifacts.prdPaths.length === 0 || artifacts.testSpecPaths.length === 0) {
    return { source: 'none', prdPath: null, planSlug: null, warnings: ['planning_incomplete'] };
  }

  const selection = selectLatestPlanningArtifacts(artifacts);
  const prdPath = selection.prdPath;
  const planSlug = prdPath ? artifactPathSuffix(prdPath, /^prd-(?<slug>.*)\.md$/i) : null;
  if (!prdPath || !planSlug) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_prd_slug'] };
  }
  if (selection.testSpecPaths.length === 0) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_matching_test_spec'] };
  }

  const sidecarName = `team-dag-${planSlug}.json`;
  const sidecarPath = join(artifacts.plansDir, sidecarName);
  if (existsSync(sidecarPath)) {
    try {
      return {
        source: 'json-sidecar',
        prdPath,
        planSlug,
        artifactPath: sidecarPath,
        content: readFileSync(sidecarPath, 'utf-8'),
        warnings: [],
      };
    } catch {
      return { source: 'none', prdPath, planSlug, artifactPath: sidecarPath, warnings: ['sidecar_unreadable'] };
    }
  }


  try {
    const prdContent = readFileSync(prdPath, 'utf-8');
    const markdownHandoff = extractTeamDagMarkdownHandoff(prdContent);
    if (markdownHandoff) {
      return { source: 'markdown-handoff', prdPath, planSlug, content: markdownHandoff, warnings: [] };
    }
  } catch {
    return { source: 'none', prdPath, planSlug, warnings: ['prd_unreadable'] };
  }

  return { source: 'none', prdPath, planSlug, warnings: [] };
}

type LaunchHintSelection =
  | { status: 'no-match' }
  | { status: 'ambiguous' }
  | { status: 'unique'; match: RegExpMatchArray; task: string };

function launchHintPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi
    : /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
}

function collectLaunchHintMatches(
  content: string,
  mode: 'team' | 'ralph',
): RegExpMatchArray[] {
  return [...content.matchAll(launchHintPattern(mode))];
}

function selectLaunchHintMatch(
  matches: RegExpMatchArray[],
  normalizedTask?: string,
  normalizedCommand?: string,
): LaunchHintSelection {
  if (normalizedCommand) {
    const exactMatches = matches.flatMap((match) => {
      const command = match.groups?.command?.trim();
      if (!command || command !== normalizedCommand) {
        return [];
      }
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      return task ? [{ match, task }] : [];
    });
    if (exactMatches.length === 0) return { status: 'no-match' };
    if (exactMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...exactMatches[0]! };
  }

  if (!normalizedTask) {
    const decodedMatches = matches.flatMap((match) => {
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      return task ? [{ match, task }] : [];
    });
    if (decodedMatches.length === 0) return { status: 'no-match' };
    if (decodedMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...decodedMatches[0]! };
  }

  const exactMatches = matches.flatMap((match) => {
    const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
    return task && task.trim() === normalizedTask ? [{ match, task }] : [];
  });
  if (exactMatches.length === 0) return { status: 'no-match' };
  if (exactMatches.length > 1) return { status: 'ambiguous' };
  return { status: 'unique', ...exactMatches[0]! };
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const approvedPlan = readApprovedPlanText(cwd, options);
  if (!approvedPlan) return { status: 'absent' };

  const selected = selectLaunchHintMatch(
    collectLaunchHintMatches(approvedPlan.content, mode),
    options.task?.trim(),
    options.command?.trim(),
  );
  if (selected.status === 'ambiguous') return { status: 'ambiguous' };
  if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };

  if (mode === 'team') {
    const workerCount = Number.parseInt(selected.match.groups.count, 10);
    if (!Number.isFinite(workerCount)) {
      return { status: 'absent' };
    }
    return {
      status: 'resolved',
      hint: {
        mode,
        command: selected.match.groups.command,
        task: selected.task,
        workerCount,
        agentType: selected.match.groups.role || undefined,
        linkedRalph: Boolean(selected.match.groups.ralph?.trim()),
        ...approvedPlan.context,
      },
    };
  }

  return {
    status: 'resolved',
    hint: {
      mode,
      command: selected.match.groups.command,
      task: selected.task,
      ...approvedPlan.context,
    },
  };
}

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  return outcome.status === 'resolved' ? outcome.hint : null;
}
