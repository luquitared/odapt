## Tool: `vidwatch` — watch a video (yours or a reference) and get text back

```
vidwatch probe <file>                              duration, streams, cost estimate — free, local
vidwatch frames <file> --at 1.5,3,7 --out <dir>    pull stills at timestamps — free, local; then Read them
vidwatch watch <file-or-youtube-url> [--json] [--fps n] [--res low|medium|high]
               [--start s --end s] [--transcript] [-p "<prompt>"] [--style "<text>"]
```

Use it for two jobs:

1. **Understanding a reference** the user gives you (a YouTube link, an upload):
   `vidwatch watch <url> --transcript` returns a timestamped timeline of what
   happens, shot by shot.
2. **Checking your own output before the user sees it.** After assembling a
   video, run `vidwatch watch final.mp4 -p "You are a hostile reviewer. List
   every visible defect: garbled text, warped hands/faces, cuts that land
   mid-word, narration that doesn't match the picture, dead air."` A friendly
   prompt misses most of what a hostile one finds. Fix what's cheap to fix and
   tell the user about anything you couldn't.

- `watch` costs a little (cents for a short clip); `probe` and `frames` are free.
- Timestamps in the output are absolute, even with `--start/--end`.
- Auth comes from `GEMINI_API_KEY`. If it's missing, skip the check and say so.
