---
name: takeover
description: Recover from a forgotten handover by analyzing a closed session's transcript. Use when you start a new session and realize the previous one didn't run /handover.
user-invocable: true
---

# Takeover Skill

Recover context from a previous session that ended without running `/handover`. This skill reads the transcript from a closed session and creates the handover document retroactively.

## When to Use

- You started a new session and realized the last one didn't handover
- You want to recover learnings from an old session
- The previous agent crashed or was terminated unexpectedly

## Instructions

When this skill is invoked:

### Phase 1: Find Recent Sessions

1. List recent session transcripts:
   ```bash
   ls -lt ~/.claude/projects/*//*.jsonl | head -20
   ```

2. Show the user a list of recent sessions with:
   - Session ID (first 8 chars)
   - Project path
   - Last modified time
   - File size (rough indicator of session length)

3. Ask the user which session to recover:
   - "Which session would you like to recover? (enter number or session ID prefix)"
   - Default to the most recent one that's NOT the current session

### Phase 2: Analyze the Transcript

1. Read the selected transcript file (the .jsonl file)

2. Extract all messages (both user and assistant) and parse them:
   ```javascript
   // Each line is a JSON object
   // Look for j.message.role === "user" or "assistant"
   // Extract text content from j.message.content
   ```

3. From the transcript, identify:
   - What was being worked on
   - Which files were modified (look for Edit/Write tool calls)
   - Any test failures mentioned
   - Any learnings or discoveries
   - Any suppressed issues (tests skipped, code commented out)
   - Any unresolved questions or decisions
   - Active tasks (look for TaskCreate/TaskUpdate calls)

### Phase 3: Generate Handover Document

Follow the same structure as the regular handover skill, but note that this is a **retroactive takeover**:

1. Read existing `.claude/handover.md` if it exists

2. Create/update the handover document with:
   - All the standard sections (see handover skill)
   - Mark this as a takeover in the Generation Log:
     `[date] Gen N (takeover): recovered from session XXXXXXXX — {summary}`

3. **Do NOT create a WIP commit** — the files may have changed since that session

### Phase 4: Output Summary

Show the user:
1. What was recovered from the old session
2. The updated `.claude/handover.md` content
3. Any warnings (e.g., "Files may have changed since that session")
4. Reminder: "Review the handover document and verify the state is accurate"

## Notes

- This skill reads transcript files directly, it doesn't have the live conversation context
- The recovered information may be incomplete compared to a live handover
- Always verify the recovered state against the current codebase
- If the project has changed significantly since the old session, some learnings may be stale

## Transcript File Location

Session transcripts are stored at:
```
~/.claude/projects/{project-path-hash}/{session-id}.jsonl
```

The project path hash is the project directory with slashes replaced by dashes, e.g.:
`-Users-marc-bude-deepkit-framework`
