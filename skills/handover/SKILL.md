---
name: handover
description: Generate a handover prompt for the next worker when ending a work session. Use this when the user says "handover", "next worker", or wants to save context for continuing later.
user-invocable: true
---

# Handover Skill

Curate the living handover document (`.claude/handover.md`) and commit WIP state so the next agent generation can continue seamlessly. The handover document is institutional memory — it accumulates learnings across sessions and is pruned each handover to prevent rot.

## Phase 1: Gather Context (automated)

Do all of these silently, no user interaction yet. **Do NOT run git commands** — you have the full conversation context and know what happened this session. The next agent can run `git log` themselves.

1. Read `.claude/handover.md` if it exists (this is the living document from previous generations)
2. Check if a plan file is active in the current session. If so, note its path
3. Run `TaskList` to capture all active tasks (pending and in-progress). These are session-local and will be lost when the session ends — they MUST be preserved in the handover document.
4. **Scan for suppressed issues** in the conversation context. These are issues that were avoided rather than fixed. Look for:
   - Tests removed from whitelists or skip-lists
   - Tests marked with `.skip`, `xit`, `xdescribe`, `@disabled`, or similar
   - Test files deleted or excluded
   - Code commented out with TODO/FIXME/HACK annotations
   - Error handling that catches and silences instead of fixing
   - Workarounds with comments like "doesn't support this yet", "crashes the compiler"
   - Features or cases explicitly excluded ("let me remove this", "skip this for now")
   This is critical — suppressed issues are the easiest things to lose permanently.
5. From conversation context, identify:
   - What was worked on this session
   - Which files were modified and why
   - Current branch name
   - Any test failures encountered (do NOT re-run tests)
   - Any discoveries, gotchas, or dead ends
   - Any unresolved technical decisions

## Phase 2: Curate Knowledge (automated)

If `.claude/handover.md` exists with entries, curate them **yourself** — don't ask the user. You have access to the codebase; they don't remember every implementation detail.

For each section with entries, verify relevance by checking the code:

- **Learnings**: Check if the code/pattern described still exists. If refactored away or behavior changed, it's stale.
- **Dead Ends**: Check if the constraint that caused the dead end still applies. If the blocker was removed, it's stale.
- **Open Questions**: Check if the code now reflects a clear decision. If so, it's resolved.
- **Suppressed Issues**: Check if the suppression (skipped test, commented code, etc.) is still present. If the issue was properly fixed and the suppression removed, it can be retired.

When a learning is confirmed still true, upgrade it from ⚠️ to ✅.

**No user interaction.** Just do the curation and move on.

## Phase 3: Write the Handover Document

Write/update `.claude/handover.md` with this structure:

```markdown
# Handover

## Init Checklist
<!-- Next agent: complete these steps IN ORDER before doing anything else. -->
1. Read this entire handover document
2. Read `CLAUDE.md` for project rules
3. Read the active plan file (if listed below) — this is the original vision
4. Run the verification command (below) to confirm expected state
5. Recreate tasks from the Tasks section via `TaskCreate`
6. Verify any unverified learnings you plan to rely on (marked with ⚠️)
7. Check the Suppressed Issues section — do not re-suppress these without noting it

## Architecture Snapshot
<!-- Slowly evolving — only update when structure actually changes. Max 15 lines. -->
<!-- Format: indented tree for structure, arrow chains for data flow, one-line annotations for key constraints. -->
{agent generates this on Gen 1 from CLAUDE.md and codebase knowledge, then only updates when architecture changes}

## Current State
<!-- Overwritten each handover -->
- **Branch**: {current branch name}
- **Active plan**: {path to plan file, or "none"}
- **Working on**: {one-line summary}
- **Dirty files**:
  - `path/to/file.ts` — {one-line annotation of what changed}
  - ...
- **Failing tests**: {test names + failure reason, or "none known"}
- **Environment notes**: {docker state, rebuilt packages, etc., or "clean"}
- **Verification command**: {single command next agent should run first to confirm state}

## Next Steps
<!-- Overwritten each handover. This is your immediate roadmap — check back here if you feel yourself drifting. -->
1. {Highest priority item with file locations}
2. ...
3. ...

## Alignment Check
<!-- Read this when you're mid-session and unsure if you're on track. -->
- **Goal**: {one-sentence description of what this work is trying to achieve}
- **Scope boundary**: {what is NOT in scope — things to avoid getting pulled into}
- **Plan file**: {path, or "none"} — if you're deviating from the plan, stop and tell the user

## Tasks
<!-- Overwritten each handover. Next agent: recreate these via TaskCreate on init. -->
- [ ] {task subject} — {description} [status: pending/in_progress]
- ...

## Learnings
<!-- Append new, remove agent-verified stale. Each entry dated. -->
<!-- ⚠️ = unverified (written by previous agent, not yet confirmed by a later agent) -->
<!-- ✅ = verified (a later agent checked and confirmed this is still true) -->
- ⚠️ [{date}] {learning}

## Dead Ends
<!-- Append new, remove agent-verified stale. Each entry dated. -->
- [{date}] Tried {approach} for {goal} — failed because {reason}

## Suppressed Issues
<!-- Append new, remove when properly fixed. Each entry has file location. -->
- [{date}] `{file:line}` — {what was suppressed and why}

## Open Questions
<!-- Append new, remove when resolved. Each entry dated. -->
- [{date}] {question}

## Generation Log
<!-- One line per handover, never pruned -->
- [{date}] Gen {N}: {one-line summary of what this session did}
```

Rules:
- **Init Checklist**: static, never changes (it's instructions for the next agent)
- **Architecture Snapshot**: slowly evolving. Generate on Gen 1 from CLAUDE.md and what you know. On subsequent handovers, only update if architecture actually changed this session (new modules, renamed paths, new data flows). If nothing changed, leave it untouched. Max 15 lines. Use this format:
  - Indented tree for directory/module structure (only top 2 levels, annotate each line)
  - Arrow chains for key data flows (`input → transform → output`)
  - One-line notes for key constraints or invariants
- **Current State**, **Next Steps**, **Alignment Check**, and **Tasks**: always overwritten completely
- **Learnings**: append new entries with ⚠️ (unverified). During curation (Phase 2), when the agent confirms a learning is still true, upgrade it to ✅. Soft cap ~15 items
- **Dead Ends**: append new, remove stale. Soft cap ~10 items
- **Suppressed Issues**: append new, remove ONLY when the issue is properly fixed (not just suppressed again). Soft cap ~10 items. Include `file:line` so the next agent can find it
- **Open Questions**: append new, remove resolved. Soft cap ~5 items
- **Generation Log**: append only, never prune. This is the audit trail
- Use date format `YYYY-MM-DD`

## Phase 4: WIP Commit

1. Stage all dirty working files AND `.claude/handover.md`
2. Create a commit with this format:

```
wip: handover — {one-line summary of current state}

Next steps:
- {step 1}
- {step 2}
- {step 3}

Handover document: .claude/handover.md
```

3. Do NOT push. The user decides when to push.

Important: Use `git add` with specific file paths. Do NOT use `git add -A` or `git add .`.

## Phase 5: Output Summary

After committing, output:
1. The full contents of the updated `.claude/handover.md`
2. The commit hash
3. A reminder: **"Next session: open `.claude/handover.md` and continue the work"**
4. If tasks were captured: **"The next agent should recreate the Tasks section via `TaskCreate` on init."**

## Size Management

If any section exceeds its soft cap, prune the oldest entries that are no longer relevant. Use your judgment — you can verify against the codebase.

The goal is to keep the document scannable. A 200-line handover document defeats the purpose.

## First-Time Use

If `.claude/handover.md` does not exist yet:
- Skip Phase 2 (no existing entries to curate)
- Create the file fresh with all sections
- Generation Log starts at "Gen 1"
