/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { isPlanningComplete, readPlanningArtifacts } from '../../planning/artifacts.js';
import { isNonCleanReviewVerdict } from '../review-verdict.js';
import {
  runRalplanConsensus,
  type RalplanConsensusExecutor,
} from '../../ralplan/runtime.js';
import { parseRalplanTaskForDesignInput, resolveRalplanTaskContext } from '../../ralplan/design-intake.js';

export interface CreateRalplanStageOptions {
  executor?: RalplanConsensusExecutor;
  maxIterations?: number;
}

/**
 * Create a RALPLAN pipeline stage.
 *
 * The RALPLAN stage performs consensus planning by coordinating planner,
 * architect, and critic agents. It outputs a plan file that downstream
 * stages consume.
 *
 * By default this remains a structural adapter — actual agent orchestration
 * happens at the skill layer. When an executor is provided, the stage can
 * drive the real ralplan runtime and persist live mode state.
 */
export function createRalplanStage(options: CreateRalplanStageOptions = {}): PipelineStage {
  return {
    name: 'ralplan',

    canSkip(ctx: StageContext): boolean {
      if (hasReviewLoopContext(ctx.artifacts)) {
        return false;
      }
      if (parseRalplanTaskForDesignInput(ctx.task).fromDesignPath) {
        return false;
      }
      return isPlanningComplete(readPlanningArtifacts(ctx.cwd));
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      try {
        const resolvedTaskContext = resolveRalplanTaskContext(ctx.cwd, ctx.task);
        if (resolvedTaskContext.status !== 'ok') {
          return {
            status: 'failed',
            artifacts: {
              stage: 'ralplan',
              task: resolvedTaskContext.task,
              fromDesignPath: resolvedTaskContext.fromDesignPath,
              errorCode: resolvedTaskContext.errorCode,
              missingAnchors: resolvedTaskContext.missingAnchors,
            },
            duration_ms: Date.now() - startTime,
            error: resolvedTaskContext.error,
          };
        }

        const effectiveTask = resolvedTaskContext.value.task;
        const designInput = resolvedTaskContext.value.designInput;

        if (options.executor) {
          const runtimeResult = await runRalplanConsensus(options.executor, {
            task: effectiveTask,
            cwd: ctx.cwd,
            maxIterations: options.maxIterations,
            designInput,
          });

          const planningArtifacts = readPlanningArtifacts(ctx.cwd);
          return {
            status: runtimeResult.status === 'completed' ? 'completed' : 'failed',
            artifacts: {
              plansDir: planningArtifacts.plansDir,
              specsDir: planningArtifacts.specsDir,
              task: effectiveTask,
              prdPaths: planningArtifacts.prdPaths,
              testSpecPaths: planningArtifacts.testSpecPaths,
              deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
              brainstormPaths: planningArtifacts.brainstormPaths,
              planningComplete: runtimeResult.planningComplete,
              stage: 'ralplan',
              runtime: true,
              iteration: runtimeResult.iteration,
              latestPlanPath: runtimeResult.latestPlanPath,
              drafts: runtimeResult.drafts,
              architectReviews: runtimeResult.architectReviews,
              criticReviews: runtimeResult.criticReviews,
              ...(designInput ? {
                designInputPath: designInput.sourcePath,
                designInputRecommendedNextSkill: designInput.recommendedNextSkill,
              } : {}),
              ...runtimeResult.artifacts,
            },
            duration_ms: Date.now() - startTime,
            error: runtimeResult.error,
          };
        }

        const planningArtifacts = readPlanningArtifacts(ctx.cwd);

        return {
          status: 'completed',
          artifacts: {
            plansDir: planningArtifacts.plansDir,
            specsDir: planningArtifacts.specsDir,
            task: effectiveTask,
            prdPaths: planningArtifacts.prdPaths,
            testSpecPaths: planningArtifacts.testSpecPaths,
            deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
            brainstormPaths: planningArtifacts.brainstormPaths,
            planningComplete: isPlanningComplete(planningArtifacts),
            stage: 'ralplan',
            instruction: designInput
              ? [
                `Run RALPLAN consensus planning for: ${effectiveTask}`,
                `Design input: ${designInput.sourcePath}`,
                'Treat the brainstorm report as design input only; do not skip open questions, acceptance criteria, or test strategy validation when drafting the PRD/test spec.',
              ].join('\n')
              : `Run RALPLAN consensus planning for: ${effectiveTask}`,
            ...(designInput ? {
              designInputPath: designInput.sourcePath,
              designInputRecommendedNextSkill: designInput.recommendedNextSkill,
            } : {}),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `RALPLAN stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function hasReviewLoopContext(artifacts: Record<string, unknown>): boolean {
  if (typeof artifacts.return_to_ralplan_reason === 'string' && artifacts.return_to_ralplan_reason.trim() !== '') {
    return true;
  }
  if (isNonCleanReviewVerdict(artifacts.review_verdict)) {
    return true;
  }

  const codeReviewArtifacts = artifacts['code-review'];
  if (!codeReviewArtifacts || typeof codeReviewArtifacts !== 'object') {
    return false;
  }

  const reviewArtifacts = codeReviewArtifacts as Record<string, unknown>;
  return (
    (typeof reviewArtifacts.return_to_ralplan_reason === 'string'
      && reviewArtifacts.return_to_ralplan_reason.trim() !== '')
    || isNonCleanReviewVerdict(reviewArtifacts.review_verdict)
  );
}
