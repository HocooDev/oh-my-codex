import { basename } from 'node:path';
import {
  isCanonicalBrainstormArtifactPath,
  readBrainstormArtifact,
  readLatestBrainstormArtifact,
  type BrainstormArtifactRecord,
} from '../planning/artifacts.js';

export interface RalplanDesignInput {
  sourcePath: string;
  slug: string;
  timestamp?: string;
  approvedRecommendation: string;
  suggestedNextCommand: string;
  handoffDecision: string;
  recommendedNextSkill: 'deep-interview' | 'ralplan' | 'none';
  content: string;
}

export interface ResolvedRalplanTaskContext {
  task: string;
  designInput: RalplanDesignInput | null;
}

export type ResolveRalplanTaskContextResult =
  | { status: 'ok'; value: ResolvedRalplanTaskContext }
  | {
    status: 'invalid';
    task: string;
    fromDesignPath: string;
    errorCode: string;
    error: string;
    missingAnchors: string[];
  };

function decodeQuotedToken(raw: string): string {
  const normalized = raw.trim();
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1).replace(/\\'/g, "'");
  }
  return normalized;
}

const FROM_DESIGN_FLAG_PATTERN = /(?:^|\s)(--from-design(?:=(?<inline>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)|\s+(?<spaced>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)))/i;

export function parseRalplanTaskForDesignInput(task: string): {
  fromDesignPath: string | null;
  taskWithoutFlag: string;
} {
  const match = task.match(FROM_DESIGN_FLAG_PATTERN);
  if (!match?.[1]) {
    return { fromDesignPath: null, taskWithoutFlag: task.trim() };
  }

  const rawPath = match.groups?.inline ?? match.groups?.spaced ?? '';
  const fromDesignPath = decodeQuotedToken(rawPath);
  const matchIndex = match.index ?? 0;
  const taskWithoutFlag = `${task.slice(0, matchIndex)} ${task.slice(matchIndex + match[1].length)}`
    .replace(/\s+/g, ' ')
    .trim();

  return { fromDesignPath, taskWithoutFlag };
}

function stripRalplanInvocationPrefix(command: string): string {
  return decodeQuotedToken(command
    .replace(/^\s*(?:\$ralplan|omx\s+ralplan|\$plan(?:\s+--consensus)?|omx\s+plan(?:\s+--consensus)?)\b/i, '')
    .replace(FROM_DESIGN_FLAG_PATTERN, ' ')
    .replace(/\s+--(?:interactive|deliberate)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function buildFallbackTask(record: BrainstormArtifactRecord): string {
  return `Create a consensus implementation plan from approved brainstorm report ${basename(record.path)}`;
}

function toDesignInput(record: BrainstormArtifactRecord): RalplanDesignInput {
  return {
    sourcePath: record.path,
    slug: record.slug,
    timestamp: record.timestamp,
    approvedRecommendation: record.approvedRecommendation!,
    suggestedNextCommand: record.suggestedNextCommand!,
    handoffDecision: record.handoffDecision!,
    recommendedNextSkill: record.recommendedNextSkill!,
    content: record.content,
  };
}

function validateBrainstormForRalplan(record: BrainstormArtifactRecord, requestedPath: string): string | null {
  if (record.missingAnchors.length > 0) {
    return `Invalid brainstorm design report at ${requestedPath}. Missing required anchors: ${record.missingAnchors.join(', ')}. Fix the report or return to $brainstorm/$deep-interview first.`;
  }
  if ((record.artifactStatus?.trim().toLowerCase() ?? '') !== 'approved') {
    return `Brainstorm design report ${requestedPath} is not approved for planning (artifact.status: ${record.artifactStatus ?? 'missing'}). Mark it approved or continue iterating in $brainstorm first.`;
  }
  if (record.recommendedNextSkill === 'none') {
    return `Brainstorm design report ${requestedPath} is not approved for planning (recommended_next_skill: none). Return to $brainstorm or gather more evidence before $ralplan.`;
  }
  if (record.recommendedNextSkill === 'deep-interview') {
    return `Brainstorm design report ${requestedPath} still requires $deep-interview before planning (recommended_next_skill: deep-interview).`;
  }
  return null;
}

export function deriveRalplanTaskFromDesign(record: BrainstormArtifactRecord): string {
  const fromCommand = record.suggestedNextCommand
    ? stripRalplanInvocationPrefix(record.suggestedNextCommand)
    : '';
  return fromCommand || record.approvedRecommendation || buildFallbackTask(record);
}

export function resolveRalplanTaskContext(
  cwd: string,
  task: string,
): ResolveRalplanTaskContextResult {
  const parsed = parseRalplanTaskForDesignInput(task);
  if (!parsed.fromDesignPath) {
    return {
      status: 'ok',
      value: {
        task: parsed.taskWithoutFlag || task.trim(),
        designInput: null,
      },
    };
  }

  const record = parsed.fromDesignPath.toLowerCase() === 'latest'
    ? readLatestBrainstormArtifact(cwd)
    : readBrainstormArtifact(parsed.fromDesignPath, cwd);

  if (parsed.fromDesignPath.toLowerCase() !== 'latest' && !isCanonicalBrainstormArtifactPath(parsed.fromDesignPath, cwd)) {
    return {
      status: 'invalid',
      task: parsed.taskWithoutFlag,
      fromDesignPath: parsed.fromDesignPath,
      errorCode: 'design_input_not_canonical',
      missingAnchors: [],
      error: `Brainstorm design report ${parsed.fromDesignPath} is not a canonical .omx/specs/brainstorm-<timestamp>-<slug>.md artifact.`,
    };
  }

  if (!record) {
    return {
      status: 'invalid',
      task: parsed.taskWithoutFlag,
      fromDesignPath: parsed.fromDesignPath,
      errorCode: 'design_input_unreadable',
      missingAnchors: [],
      error: `Unable to read brainstorm design report from ${parsed.fromDesignPath}. Expected a canonical .omx/specs/brainstorm-<timestamp>-<slug>.md artifact.`,
    };
  }

  const validationError = validateBrainstormForRalplan(record, parsed.fromDesignPath);
  if (validationError) {
    const errorCode = record.missingAnchors.length > 0
      ? 'design_input_missing_anchors'
      : (record.artifactStatus?.trim().toLowerCase() ?? '') !== 'approved'
        ? 'design_input_not_approved'
        : record.recommendedNextSkill === 'none'
          ? 'design_input_no_planning_handoff'
          : 'design_input_requires_deep_interview';
    return {
      status: 'invalid',
      task: parsed.taskWithoutFlag,
      fromDesignPath: parsed.fromDesignPath,
      errorCode,
      missingAnchors: record.missingAnchors,
      error: validationError,
    };
  }

  return {
    status: 'ok',
    value: {
      task: parsed.taskWithoutFlag || deriveRalplanTaskFromDesign(record),
      designInput: toDesignInput(record),
    },
  };
}
