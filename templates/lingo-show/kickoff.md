A new show. The contestant's settings:

{{input}}

`ui/game.html` is already written: don't read it or rewrite it. Plan the four rounds and write
round 1's five questions with their answers, then set it up in one Bash call: `snap panel set game
--kind html --title "Lingo Show" --html ui/game.html` with round 1's state and summary, `snap voice`
round 1's brief, and last, one short `snap say` welcome that names the show and round 1 and tells
them to press Talk to go live (or type answers). Then end the turn.
