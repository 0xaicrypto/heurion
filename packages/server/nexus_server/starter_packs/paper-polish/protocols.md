## Paper Polish integrity protocols

Non-negotiable. The Patcher and Judge enforce these. PaperFit's
"content protection" doctrine — formatting fixes must NEVER quietly
mutate the paper's meaning.

1. **Never delete figures, tables, captions, or labels.** If a
   visual element doesn't fit the page budget, the Patcher
   re-flows / resizes / re-anchors it — never drops it. Deleting a
   figure = invalidates the paper's claim. WONTFIX is the correct
   move when a figure genuinely doesn't fit.

2. **Never silently rewrite equations or claim values.** Numbers in
   results tables, equations, and theorem statements are sacred.
   The Patcher may relabel, reformat, or move them — never change
   their content. If a number looks wrong, flag as a finding for
   the author, don't auto-correct.

3. **Cite-by-key is canonical.** When fixing C-tier citation
   defects, match the bib entry by `\cite` key. Never substitute
   a different paper because the author's intended citation looks
   off — flag and ask.

4. **No `\resizebox` to hide overruns.** Tables / figures over
   column width get re-flowed (column splits, `tabularx`,
   `multirow`, or `\small` font shift). `\resizebox{}` is the
   last resort, and only with a one-line WONTFIX-style note in
   the patch explaining why nothing else worked.

5. **Venue conventions trump local style.** If `venue` is CVPR,
   the venue's stylesheet wins over the paper's existing
   inconsistencies. If venue is `generic`, preserve the paper's
   own conventions.

6. **Environment honesty.** The Inspector MUST emit
   `environment_flags` so downstream agents and the Judge know
   what's verifiable. Don't claim "visual inspection complete"
   when you only saw the .tex source. The Judge auto-WONTFIXes
   A-tier defects when TEXT_ONLY is set — that's correct
   behaviour, not a workaround.

7. **Page-budget edits are last-resort.** If `page_budget` forces
   trimming, the Patcher prefers (in order): tighter column gaps,
   `\vspace` shaves, smaller float sizes, paragraph reflow, then
   — only if all of the above fail — flagging a SUGGESTION to the
   author to cut a specific section. The Patcher does NOT cut
   prose on its own.

8. **WONTFIX requires justification.** Every WONTFIX status carries
   a one-line reason. "Author intent" / "venue convention X" /
   "environment can't verify". Bare WONTFIX is treated as BLOCKED
   by the Judge.
