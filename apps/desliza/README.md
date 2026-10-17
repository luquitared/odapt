# Desliza

A TikTok-style feed for learning Spanish from famous moments in Hispanic pop culture and history:
telenovelas, El Chavo, Selena, Maradona, García Márquez's Nobel speech, viral memes. Each screen plays
a short window of a YouTube clip on a loop, with the Spanish line everyone quotes painted over it (tap it
for the English) and a sheet of phrases from the clip. Every four or five clips a quiz card asks about one
you watched. XP, a daily streak and saved phrases ("Mi vocabulario") live in the browser's
localStorage; there is no account and no server.

It's a static page (`index.html`, `style.css`, `app.js`, `events.js`) with no build step. Every URL is
relative, so it works served under a path.

## Run it locally

```sh
bunx serve apps/desliza
# or
cd apps/desliza && python3 -m http.server 8123
```

Open it at `http://localhost:<port>/`, not `127.0.0.1`: YouTube refuses label-owned videos (VEVO and
the like) on a bare IP origin with error 150, and the cards fall back to "Watch on YouTube". Keyboard: ↑/↓ (or j/k) to move, space to pause, M for sound, 1–3 to answer a quiz.

## Data

The page loads `data/clips.json` and falls back to `data/sample.json` (a few clips for development) if
it's missing or empty. The format is in [`data/SCHEMA.md`](data/SCHEMA.md). Every `youtube_id` must be
embeddable (the oEmbed endpoint returns 200); a clip whose video refuses to embed shows its thumbnail and a
"Watch on YouTube" link instead.

## Analytics

`events.js` posts funnel events (`view`, `start`, `clip_view`, `line_reveal`, `phrases_open`,
`phrase_saved`, `quiz_answer`, `unmute`, `filter`, `scroll_deep`) to `https://api.odapt.ai/events` with
an anonymous per-browser session ID. It does nothing on localhost.
