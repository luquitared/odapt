## HTML panels

This app lets you draw panels yourself. An `html` panel is a web page you write. It runs in a sandboxed
frame inside the panel, and it talks to the session through `window.snap`. Use it for the view the app
is built around: a game board, a live scoreboard, a comparison you drag things around on, anything the
built-in kinds can't show. Use the built-in kinds for everything else; they cost you nothing to draw.

**Write the page once, then drive it with state.** The page draws itself from `state`, a JSON value
you own. Each turn you patch only `state`: the page updates in place, keeping scroll, focus and
animation. Rewrite the HTML only when the page needs a new view, or when the user asks for a different
look ("make it darker", "more like an arcade"). That is a normal request here: edit the file and patch
`--html`, and the state carries over.

```
snap panel set game --kind html --title "Game" --html ui/game.html --state @state.json --summary "Round 1 of 10"
snap panel patch game --state '{"round":2,…}' --summary "Round 2 of 10, 3 points"   # each turn
snap panel patch game --html ui/game.html                                          # a new design
```

`--state` replaces the whole state (send all of it). `--summary` is one plain sentence of what the page
shows right now; the voice and anything else that can't see the page reads it, so keep it current.
Keep the HTML in a file in your working directory (`ui/<panel>.html`) so you can edit it rather than
rewrite it.

### The page

Write a full document or a fragment; it is wrapped either way. Inside it:

- `snap.onState((state, status) => draw(state))`: called once at load and again on every change.
  Render everything from `state`, idempotently, and leave alone a text box the user is typing in.
  `status` is the panel's status.
- `snap.action("hint", {…})`: a button press. It reaches you as your next message, with its payload.
  Names are yours (letters, digits, `-`, `_`), except `message`, `answer` and `voice`.
- `snap.send("text")`: the same as the user typing in the chat. Use it for a text box on the page.
- `snap.edit({key: value})`: merged into `state` and saved quietly, without waking you (you'll see
  it next time you read the panel). For choices the user makes before pressing something.
- `snap.theme`: the studio's colors (`bg surface ink muted line accent ok warn bad`), also as CSS
  variables `--snap-bg` etc. Use them or ignore them; the page can have its own look.

Rules the frame enforces: no network (`fetch` and forms are blocked), no pop-ups, no storage you can
rely on. Scripts may load from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` and `unpkg.com`, fonts from
Google Fonts, and images, audio and video only from `snap asset put` URLs or `data:`. The frame grows to
fit the page's height, so don't size anything with `vh`.

### Making it good

It's someone's whole screen, so design it for this app, not as a generic card: a type pairing, a
palette and one big signature element that fit what the app is about. Make the current thing the
biggest thing on the page. Animate changes (a new round sliding in, a score ticking up) with CSS
transitions, briefly. It must work at 360px wide, in light and dark (`prefers-color-scheme`), with
real buttons (keyboard-reachable, visible focus). Never put payment, password or sign-in fields in a
page.
