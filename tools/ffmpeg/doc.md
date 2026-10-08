## Tool: `ffmpeg` / `ffprobe` — cut, fit and assemble locally (free)

- Measure before you fit: `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`.
- Narration drives length. Speech runs ~1.8–1.9 words per second; a 6-second
  shot holds about 11 words. If a clip is shorter than its narration, slow the
  clip (`setpts`) or hold the last frame (`tpad=stop_mode=clone`) — never cut the voice.
- Normalize every clip to the same size, fps and pixel format before concat
  (`scale=…,fps=24,format=yuv420p`), or the concat will glitch.
- Mix music *under* narration (`volume=0.15` on the bed, `amix` with `duration=first`).
- Write finished files with `-movflags +faststart` so they stream in the browser.
