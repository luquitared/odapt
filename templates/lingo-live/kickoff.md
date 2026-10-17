A new trip. The learner's settings:

{{input}}

`ui/game.html` is already written: don't read it or rewrite it. Plan the trip (a city and five
stops), then set it up in one Bash call: `snap panel set game --kind html --title "Lingo Live"
--html ui/game.html` with stop 1's state and summary, `snap voice` stop 1's brief, and last, one
short `snap say` welcome that names the city and the first stop and tells them to press Talk (or
type their lines). Then end the turn.
