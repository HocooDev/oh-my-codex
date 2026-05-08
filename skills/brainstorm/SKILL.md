---
name: brainstorm
description: "Pre-planning design exploration workflow that turns vague ideas into reviewable design reports before deep-interview or ralplan"
argument-hint: "[--with-claude] [--with-gemini] [--lang <auto|en|zh-CN|zh-TW>] <idea or proposal>"
---

# Brainstorm — Multi-Agent Design Exploration Before Planning

<Purpose>
Brainstorm is the design-exploration lane that sits before `$deep-interview` and `$ralplan`.
It turns a vague feature idea, architectural direction, or proposal into a reviewable design report with candidate options, explicit trade-offs, a recommendation, and a handoff decision.
</Purpose>

<Use_When>
- The user has an idea but is not yet sure it is the right idea
- The user wants to compare multiple designs before approving a direction
- The user wants a design report first, not an implementation plan
- The user wants pre-planning exploration that can later feed `$deep-interview` or `$ralplan`
</Use_When>

<Do_Not_Use_When>
- The user already wants requirements clarification around goals, scope, acceptance criteria, or non-goals first -- use `$deep-interview`
- The user already approved the design direction and now needs the implementation plan -- use `$ralplan`
- The user wants code changes, implementation, or execution -- use `$ralph`, `$team`, or the appropriate execution lane instead
</Do_Not_Use_When>

<Why_This_Exists>
Some requests are too early for planning but too important to execute on instinct. Brainstorm gives OMX a bounded design-discussion lane that explores options, challenges assumptions, and produces a durable report without pretending to be requirements interview or implementation planning.
</Why_This_Exists>

<Execution_Policy>
- Use outcome-first framing and outcome-first progress and completion reporting.
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints.
- If the user says `continue`, keep refining the current design exploration branch instead of restarting context intake or repeating the same option list.
- Do not implement code.
- Do not create the final execution plan.
- Do not invoke `$ralph`, `$team`, or `$autopilot` from brainstorm.
- Do not enter `$ralplan` before explicit user approval of the design direction.
- Continue through clear, low-risk, reversible exploration steps automatically; ask only when a missing answer materially changes the design recommendation.
</Execution_Policy>

<Responsibilities>
- Restate the idea and desired design outcome
- Inspect the smallest relevant project context
- Ask focused clarification questions when they materially affect the design
- Generate 2-3 candidate solutions
- Analyze pros, cons, risks, compatibility, testing cost, and maintenance cost
- Recommend one direction
- Write a reviewable markdown design report
- Prepare a clean handoff to `$deep-interview`, `$ralplan`, more research, or no-ship
</Responsibilities>

<Non_Responsibilities>
- Direct code changes
- Detailed execution plan / task-by-task implementation plan
- Automatic execution handoff
- Approval bypass
- Pretending design uncertainty is the same thing as requirements uncertainty
</Non_Responsibilities>

<Pre-context Intake>
Before option generation, ground the workflow in real repository context:

1. Derive a short slug from the task.
2. Reuse the latest relevant context snapshot in `.omx/context/{slug}-*.md` when available.
3. If none exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. Read only the files needed for the current idea; do not perform a meaningless full-repo sweep.
</Pre-context Intake>

<Agent_Orchestration>
Brainstorm is a leader-orchestrated multi-agent workflow.

Default lanes:
1. **Repo context lane — `agent-explore`**
   - Use `$agent-explore` for read-only repository scanning, relevant file discovery, current workflow touchpoints, and artifact/state conventions.
   - `agent-explore` owns repo-local facts only.
2. **Architecture lane — `agent-architect`**
   - Use `$agent-architect` for option generation, trade-off analysis, compatibility reasoning, and recommendation framing.
   - `agent-architect` is read-only and must ground important claims in repository evidence.
3. **Drafting lane — `agent-writer`**
   - Use `$agent-writer` to convert the exploration results into the final markdown report in the user’s language.
   - `agent-writer` must not invent architecture decisions; it documents the leader-approved synthesis.
4. **Review lane — critic / reviewer**
   - Run at least one challenge pass over the draft and recommendation.
   - The review lane must explicitly test for overlap with `$deep-interview`, overlap with `$ralplan`, approval bypass risk, unstable artifact structure, and fake option diversity.

Parallelism contract:
- Launch the repo context lane and architecture lane in parallel whenever possible.
- Start the drafting lane after the first evidence-backed context and architecture outputs are available.
- Run the review lane after the first draft exists, then revise once before finalizing the report.
</Agent_Orchestration>

<Optional_External_Advisors>
External local advisors are optional and disabled by default.

- `--with-claude` or equivalent config may add `omx ask claude` as a second-opinion lane.
- `--with-gemini` or equivalent config may add `omx ask gemini` as an alternative-ideas lane.
- If neither flag/config is enabled, do not call external advisors.
- External advisors provide supplementary perspective only; they do not replace `agent-explore` for repo facts or `agent-architect` for the main recommendation.
- Save advisor artifacts under `.omx/artifacts/ask-<backend>-<slug>-<timestamp>.md` and reference them in the report when used.
</Optional_External_Advisors>

<Workflow>
1. Restate the idea and current uncertainty.
2. Inspect the smallest relevant project context.
3. Ask at most one clarification question at a time.
4. Use `agent-explore` to map the current repo shape.
5. Use `agent-architect` to generate 2-3 viable options with explicit trade-offs.
6. Use `agent-writer` to draft the markdown report in the user's language.
7. Run at least one review/challenge pass and revise the draft.
8. Write the report to the canonical artifact path.
9. Ask the user to approve, revise, continue exploring, or stop.
10. Only after explicit approval, recommend the next workflow (`$deep-interview`, `$ralplan`, further research, or no implementation).
</Workflow>

<Report_Template>
Write the final report to:

```text
.omx/specs/brainstorm-<timestamp>-<slug>.md
```

The report must include:

```markdown
# Brainstorm Report: <title>

## 1. Original Idea
## 2. Current Understanding
## 3. Context Scan
## 4. Goals
## 5. Non-goals
## 6. Constraints
## 7. Open Questions
## 8. Candidate Solutions
## 9. Recommendation
Approved recommendation: <one-line approved direction>

## 10. Proposed Workflow
## 11. Proposed Artifact Contract
## 12. Integration With Existing OMX Skills
## 13. Risks and Mitigations
## 14. Testing Strategy
## 15. Ralplan Handoff
Suggested next command: $ralplan --from-design .omx/specs/brainstorm-<timestamp>-<slug>.md "<planning task>"

## 16. Handoff Decision
Handoff Decision: <approved for ralplan | needs deep-interview | continue research>
```

Required handoff contract:

```yaml
artifact:
  type: brainstorm_design_report
  path: .omx/specs/brainstorm-<timestamp>-<slug>.md
  status: draft | approved | superseded
  recommended_next_skill: deep-interview | ralplan | none
```

The heading text and anchor labels above are machine-consumed contracts. Do not rename `# Brainstorm Report:`, `## 9. Recommendation`, `## 15. Ralplan Handoff`, `## 16. Handoff Decision`, `Approved recommendation:`, `Suggested next command:`, or `Handoff Decision:`.
</Report_Template>

<Language_Policy>
- The report, visible summaries, and approval prompts must match the user's language environment.
- Prefer the language of the latest user request unless the user explicitly asks for another output language.
- Keep skill names, commands, and literal workflow identifiers such as `$brainstorm`, `$deep-interview`, and `$ralplan` unchanged.
- If the user writes in Chinese, produce the report in Chinese unless they request English.
</Language_Policy>

<Handoff_Rules>
- Brainstorm handles design uncertainty.
- `$deep-interview` handles requirements / goals / scope / acceptance uncertainty.
- `$ralplan` handles approved implementation planning.
- `$ralph` / `$team` handle execution after planning.

Allowed next-step recommendations:
- `next_skill: deep-interview` -- design is directionally useful, but requirements/boundaries are still unclear
- `next_skill: ralplan` -- design is approved and planning can begin
- `next_skill: none` -- more research is needed or implementation is not recommended

Brainstorm may recommend a next step, but it must not auto-trigger it before explicit user approval.
</Handoff_Rules>

<Scenario_Examples>
**Good:** The user says `continue` after reading Option A and Option B. Continue the current exploration, tighten trade-offs, and update the report draft instead of redoing context scan from scratch.

**Good:** The user changes only the preferred output language. Preserve the existing design analysis and reframe the visible output in the requested language.

**Bad:** The user asks for design exploration, and brainstorm jumps directly into file-level implementation tasks or launches `$ralph`.
</Scenario_Examples>

<Final_Checklist>
- [ ] Repository context was scanned before recommending a design
- [ ] `agent-explore` was used for repo-local facts
- [ ] `agent-architect` was used for trade-off analysis
- [ ] `agent-writer` was used for the final report draft
- [ ] At least one review/challenge pass happened
- [ ] 2-3 candidate options are compared explicitly
- [ ] Recommendation is justified with trade-offs
- [ ] Report is saved under `.omx/specs/brainstorm-<timestamp>-<slug>.md`
- [ ] Report language matches the user's language environment
- [ ] No direct implementation or automatic execution handoff occurred
</Final_Checklist>

Task: {{ARGUMENTS}}
