<!--
Delete any section you do not fill, and delete this comment.
**The body goes into the database as is** (server/src/github.ts; the diff does not). Each PR becomes one conversation,
found by message search (recall mode: said) and gleanery dashboard search.
This is the only explanation that shows up there, so do not water it down with boilerplate.

If this PR resolves an issue, put `Closes #12` on one line at the top of the body (merging closes it).
Use `Refs #12` for related issues it does not resolve. One PR does not always finish an issue,
so do not mix up Closes and Refs. List several on separate lines. Do not add a heading for them.
-->

## What changed

<!-- 1 or 2 lines: what works now. Do not restate the diff. -->

## Decisions

<!--
One line each. **Include the reason for each rejected option.** Without it, nothing was really decided,
and half a year later the same option gets rejected again for the same reason.
Lines in the form `- Chosen: <option>. Rejected: <option> (<reason>); <option> (<reason>)` are imported as gleanery
decision records after the merge (server/src/decisions.ts). Lines in any other form stay only as messages.
Optionally, indent `  - Terms: word, word` under a decision: short search words a later reader might type (synonyms, abbreviations, English
equivalents, and a word the owner used for it when that word is fine to keep in this public body). They are indexed for the decision and its options and never shown in search results. A blank `  - Terms:` clears them; deleting the line keeps the old ones.
-->

## Verification

<!--
The commands you ran and their output. **Paste output that passed, not "should pass".**
For a fix, also state that you confirmed the code failed (red) before the fix.
Mark checks you did not run as "not verified", with the reason.
Always include the Codex review result (how many findings and how each was handled). Without it, CI (pr-body) fails.
-->

## Release notes

<!--
Only for PRs that ship (release:plan says plugin). Otherwise delete this section.
Describe the change as users see it and the commands to update. Do not name internal implementation details.
After promotion to latest, this section becomes the GitHub Release body as is (no further review).
-->

## Declined findings

<!--
Review findings you did not fix, and why. Include the issue number if you filed one.
Delete this section if there are none.
-->
