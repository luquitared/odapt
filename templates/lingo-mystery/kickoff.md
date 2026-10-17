A new case. The learner's settings:

{{input}}

`ui/game.html` is already written: don't read it or rewrite it. Plan the case, then set it up in
one Bash call: write the plan to `case.md` (a quoted heredoc: what happened, the culprit and how the
clues prove it, each suspect's alibi, secret, and which question gives which clue), `snap panel set game --kind html --title "Lingo Mystery" --html ui/game.html` with interview 1's
state and summary, `snap voice` interview 1's brief, and last, one short `snap say` that sets the
scene in English (what happened, who they'll question first) and tells them to press Talk (or type
their questions). Then end the turn.
