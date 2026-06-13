## Code review integrity protocols

Non-negotiable across every step of this workflow. Judge enforces.

1. **Quote the line before claiming a bug.** Every finding must cite
   the actual code being criticised — file path + line range when
   available, or the literal snippet otherwise. "Looks like there's
   a race somewhere in the worker" is not a finding; it's a hunch.
   Hunches go under OPEN_QUESTIONS, not FINDINGS.

2. **No fabricated APIs.** If a finding suggests "use the existing
   helper X", you must have seen X in the diff or in the user's
   provided context. Do not assume helpers exist. Do not invent
   library functions.

3. **Severity is not negotiable.** A "potential race condition" with
   no concrete trigger scenario is MEDIUM at most. CRITICAL and HIGH
   require a one-line reproduction or attack story (input X → bug Y).

4. **No bikeshedding under MEDIUM.** Naming preferences, blank-line
   counts, and "I'd write this differently" go under NIT, not LOW.
   The Judge counts the LOW/MEDIUM bucket; excess noise dilutes the
   real issues.

5. **No silent rewrites.** Suggested patches must (a) preserve the
   author's behaviour where not flagged, and (b) be reachable from
   the cited finding. Don't bundle a 200-line "while I was here"
   refactor into a fix for an off-by-one.

6. **Author intent first.** If the user supplied a `context` input
   ("this is a hotfix for production X"), the bar shifts: scope
   creep findings drop to LOW or NIT. A reviewer that ignores intent
   gets the wrong urgency on everything.

7. **Tests count as code.** Missing test for a new branch IS a HIGH
   if the branch handles error paths or security boundaries. The
   Style/Tests step enforces this — a clean Bugs pass with an empty
   test diff is suspicious.

8. **The summarizer doesn't add new findings.** By the time the
   Summarize step runs, the finding inventory is frozen. Summarize
   only consolidates, ranks, suggests patches, and marks each
   finding's status. New material → INSIGHT block, not a new [F#].
