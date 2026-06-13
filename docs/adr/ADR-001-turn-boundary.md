# ADR-001: Turn boundary — when does the agent stop talking to itself and start talking to the user?

**Status:** Proposed
**Date:** 2026-05-03
**Deciders:** JZ (architect), agent-runtime owners

## Context

`packages/sdk/nexus_core/llm/client.py::_chat_with_tool_loop` ends a turn the moment the LLM emits a text response without a tool call:

```python
for round_num in range(MAX_TOOL_ROUNDS):  # MAX_TOOL_ROUNDS = 5
    response = await self._call_with_tools(...)
    if not response.get("tool_calls"):
        return response.get("text", "")          # <-- turn ends here
    ...
```

The LLM, not the runtime, decides when the turn is done. That works for chit-chat, but for any task that needs more than one tool round it pushes the user into a "press enter to continue" loop:

- file_reader returns a 60K-char chunk → LLM writes "I read part of it, want me to keep going?" → turn ends → user must reply "yes" before the agent reads the next chunk.
- search → read → verify → summarize gets cut off after the first text the LLM emits.
- Background self-improvement (skill evolution, memory compaction triggered by a chat goal) is structurally impossible because the LLM can't yield "I'm still working" without a tool call.

We patched the symptom on file_reader twice already:

1. Raised the chunk cap from 8K → 200K → 1M.
2. Added imperative prompt text: "DO NOT pause to ask 'should I continue reading?' between chunks."

Both are soft constraints. The user observation that triggered this ADR — *"agent 回答的太早 ... turn 不是连续的"* — is correct. As long as the LLM's free-form text can end the turn, no amount of prompt engineering or chunk-size tuning is load-bearing.

The product premise is "self-evolving digital twin that runs in the background." The current turn loop contradicts that — the agent can only act while the user is actively replying.

### Constraints

- Single solo developer; we have weeks, not quarters.
- Three LLM providers behind one interface (Gemini, Anthropic, OpenAI). Anything we change has to ride on the existing `LLMClient` shim.
- Existing tool registry and `ThinkingEmitter` plumbing should stay; we're not rewriting the agent.
- Must not regress short factual chat ("今天周几") — those should still finish in one round.
- Cap on wall-clock time per user message stays bounded (current ≈ MAX_TOOL_ROUNDS × PER_TOOL_TIMEOUT = 5 × 90s).

## Decision

Adopt **Option A — explicit `respond_to_user` tool as the only legal turn-terminator**, with **Option C's `tool_choice="any"` enforcement** as a belt-and-braces fallback when the LLM tries to slip out via free text.

Rationale: Option A is the only one of the three that actually decouples "turn boundary" from "the LLM happened to write text this round." B and C are patches that move the cliff but keep it. The soft-constraint history (8K → 200K → 1M, "DO NOT pause" prompt) is direct evidence that patching the cliff doesn't hold.

## Options Considered

### Option A — Explicit `respond_to_user(text)` tool

A new built-in tool. Calling it is the only way to deliver text to the user; calling it ends the turn. Free-form text from the LLM is captured into the thinking pane (visible to the user as "agent is thinking…") and the loop continues with an injected reminder: *"You have not yet called respond_to_user. Continue the task."*

| Dimension | Assessment |
|-----------|------------|
| Complexity | Med — new tool + loop predicate change + system prompt edit + thinking emitter routing |
| Cost | One-time engineering ~1 day; runtime cost = same LLM tokens, possibly +1 round per turn for short answers |
| Scalability | Works for 1-round and 20-round turns alike |
| Team familiarity | Same pattern as Claude Code's `attempt_completion`, Cursor's tool-use loop, agent SDK ReAct templates |

**Pros:**
- Turn boundary is structural, not stylistic — LLM can't accidentally end a turn by being chatty mid-task.
- file_reader/search/etc. tool descriptions can stop being apologetic ("DO NOT pause to ask…") because there is no "pausing"; the only way to stop is `respond_to_user`.
- Long autonomous flows (multi-step research, self-evolution triggered by chat goals) become possible without redesigning the runtime later.
- Keeps a clean trace: thinking pane gets all the in-flight reasoning text, chat gets one clean reply per turn.

**Cons:**
- Breaking change for any caller / test that asserts the LLM's first text response IS the assistant message. Need to grep `_chat_with_tool_loop` callers.
- Need a fallback ceiling. If the LLM gets stuck never calling `respond_to_user`, we'd loop forever. Cap at e.g. `MAX_TOOL_ROUNDS = 20` and on overshoot, take whatever last free text the LLM emitted as the reply (with a "[turn cap reached]" badge).
- System prompt has to change for every persona, and persona drift (the `persona.yaml` history) becomes more sensitive.

### Option B — `incomplete=True` sentinel on tool results + auto-continue

Tools that produce paginated/partial results return a structured `incomplete=True, hint="..."` field. The runtime checks this; if the previous tool returned incomplete=True AND the LLM responded with text instead of another tool call, the runtime treats the text as thinking and re-prompts: *"Your last tool result was incomplete; continue."*

| Dimension | Assessment |
|-----------|------------|
| Complexity | Med — one new tool-result field + loop predicate + N tools updated to set the field |
| Cost | ~1 day, but cost is per-tool (every "loopable" tool needs the field) |
| Scalability | Solves the file_reader case directly; partially solves the multi-step case |
| Team familiarity | Custom protocol — less recognizable to anyone else jumping in |

**Pros:**
- Zero impact on simple turns (no `incomplete` flag → behavior unchanged).
- Per-tool opt-in: file_reader and search opt in immediately; persona-edit / register-on-chain stay one-shot.
- No system prompt change required.

**Cons:**
- Doesn't solve the general "agent should keep working until done" pattern, only the "this specific tool returned partial data" pattern. Multi-step research (read → grep → read again → summarize) still bails out at the first text response.
- Every new loopable tool author has to remember the protocol.
- Doesn't unblock background self-evolution.

### Option C — Detect "more remaining" in tool output + force `tool_choice="any"`

Runtime parses the file_reader (and similar) output for the existing footer (`[N more chars remaining…]`) and on the next round calls the provider with `tool_choice="any"` (Anthropic) / `tool_config.function_calling_config.mode = "ANY"` (Gemini) / `tool_choice="required"` (OpenAI), which forces the LLM to emit a tool call rather than text.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one regex + provider-specific tool_choice plumbing in 3 branches |
| Cost | A few hours |
| Scalability | Patches file_reader; nothing else benefits |
| Team familiarity | Standard provider feature, but special-cased per call site |

**Pros:**
- Smallest diff. Lowest risk.
- Doesn't change persona prompt at all.

**Cons:**
- It's a special case for file_reader. Same mechanism would have to be re-implemented for every future tool that wants self-loop semantics.
- Provider drift: any provider that ever drops/renames tool_choice semantics breaks the patch silently.
- Doesn't fix the underlying "LLM-decides-turn-end" coupling — we'd be back here in two months with a different tool.

## Trade-off Analysis

The real question is **whether turn boundaries are an LLM-decision concern or a runtime-decision concern.**

- B and C accept that the LLM decides, then add hacks for individual cases the LLM gets wrong.
- A inverts that: the runtime decides, the LLM has to use a structured channel to talk to the user.

Once you're committed to building a self-evolving agent (which the rest of this codebase is), A is the only choice that scales. B and C buy us time but we'd be revisiting them every quarter as new tool patterns emerge.

The only reason to pick C right now is "we ship this week and can't risk a bigger refactor." That's a real reason — but the demo path doesn't actually need long autonomous loops; it needs PDF reading not to sound stupid. C plus the existing 1M-char file_reader would cover the demo. A is the right answer for the next sprint.

**Recommended path: do A. If we run out of time before a milestone, ship C as a 30-line patch and revert it the same week we land A.**

## Consequences

### What becomes easier
- file_reader can drop the imperative prompt language and the 1M-char ceiling argument; agents naturally loop until they have what they need.
- Long-form research turns ("read this PDF, search the on-chain log for related anchors, summarize") work without user nudging.
- Background self-evolution can run inside a turn by chaining tool calls without the LLM accidentally emitting text and ending things.
- Test harness for agent flows gets simpler — assert "respond_to_user was called with X" instead of mocking the loop.

### What becomes harder
- System prompt grows. Persona evolution has to preserve the `respond_to_user` instruction across version bumps — add a unit test for this.
- Debugging "why did the agent stop?" requires looking at the thinking pane (which now carries genuine in-flight reasoning), not the chat log. Desktop UI needs a small badge: "agent thought N times before replying."
- Every existing test that asserts on the LLM's text response shape needs auditing. Best estimate ~10 tests under `packages/sdk/tests` and `packages/nexus/tests`.

### What we'll need to revisit
- Token budget: thinking pane now stores more text than before. If it grows unboundedly, set a per-turn cap and truncate.
- Streaming: today the user sees the LLM's first text immediately. With A, they see "thinking…" longer before the final reply. Consider streaming `respond_to_user`'s `text` argument so the reply renders progressively.
- Cost: at MAX_TOOL_ROUNDS = 20 with worst-case all-text rounds, a single user message could cost 20× more in LLM tokens. Add a per-turn token budget alarm.

## Action Items

1. [ ] **Define the tool.** Add `RespondToUserTool` to `packages/sdk/nexus_core/tools/` with a single required string param `text` and an optional `done: bool = True`. Register it in the default ToolRegistry.
2. [ ] **Change the loop predicate.** In `_chat_with_tool_loop`, terminate on `tool_call.name == "respond_to_user"` instead of "no tool calls." Capture the `text` arg as the assistant message.
3. [ ] **Route free text to thinking pane.** When the LLM emits text without `respond_to_user`, emit it as a `reasoning` event via `ThinkingEmitter` and inject a synthetic system message: *"You did not call respond_to_user. The user has not seen your last message. Continue the task or call respond_to_user to reply."*
4. [ ] **Raise `MAX_TOOL_ROUNDS` to 20**, keep `PER_TOOL_TIMEOUT_SECONDS = 90.0`. Worst case wall time is now 30 minutes, which is fine for an autonomous turn but needs a desktop-side "cancel" affordance (already exists).
5. [ ] **Belt-and-braces:** when `MAX_TOOL_ROUNDS` is hit without `respond_to_user`, take the most recent free text as the reply and append `\n\n[turn cap reached after N rounds]`.
6. [ ] **System prompt patch.** In `packages/nexus/nexus/twin.py` ~L1188-1200, replace the "function calling" block with explicit `respond_to_user` instructions: when to call it, that it's the ONLY way to address the user, that thinking text is private.
7. [ ] **Drop the apology language** in `file_reader.py` description ("DO NOT pause to ask 'should I continue reading?'") — it's no longer needed and confusingly references the old behavior.
8. [ ] **Test sweep.** Audit `packages/sdk/tests/test_*.py` and `packages/nexus/tests/test_twin.py` for any assertion shape that assumes "text response = turn end." Likely 10ish tests.
9. [ ] **Desktop badge.** Add a small "thought N times" indicator to the assistant message bubble (data already in `tool_calls_log`).
10. [ ] **Persona-evolution invariant test.** Add a test that runs the persona evolver and asserts the resulting prompt still contains the `respond_to_user` instruction block.
11. [ ] **Token-budget alarm.** Log a warning when a single turn exceeds N tokens; expose a counter to the cognition column.
12. [ ] **Ship behind a flag** (`NEXUS_TURN_BOUNDARY=explicit|legacy`, default `explicit` after one week of dogfooding) so we can roll back without a deploy.

## Rollback plan

If A misbehaves in production, set `NEXUS_TURN_BOUNDARY=legacy` to fall back to the current "first text wins" loop. Keep the legacy branch in `_chat_with_tool_loop` for one minor version, then delete.
