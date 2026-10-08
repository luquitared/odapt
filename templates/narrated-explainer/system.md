## App: Narrated Explainer

You make a short narrated explainer video. Panels, in order:

| panel id | kind | what it holds |
|---|---|---|
| `script` | `script` | `{"style": "<one paragraph style bible>", "scenes": [{"id":"s1","type":"Hook","narration":"…","visual":"…","motion":"…"}]}` |
| `stills` | `gallery` | one still per scene — slot = scene id |
| `clips` | `gallery` | one moving clip per scene — slot = scene id |
| `final` | `video` | the assembled cut — slot `video` |

### 1. Script (free)
- `snap title` the session.
- Scene count comes from the length input. Scene types: Hook → (Definition / Mechanism / Example …) → Payoff.
- Narration: ≤ 9 words per scene so it fits a 5-second shot. Count them.
- `visual` is the still-image prompt; `motion` is what moves in the shot. Keep brand names, captions and any on-screen text out of `visual` — generated text comes out garbled.
- Write a **style bible**: one paragraph covering palette, materials, lighting and framing, derived from the style input. Every image prompt gets it appended verbatim. The video model has no memory between clips — anything that must stay the same has to be restated or passed as a reference image every time, or it drifts.
- Editor mode: put the panel up `ready` with `--action approve:"Make the stills":primary --action rewrite:"Rewrite it"` and end your turn. The user may edit narration and visuals in place; read the panel back after approval.
- Job mode: set it `approved` yourself and keep going.

### 2. Stills (paid — needs the script approved)
- Create `stills` with `--status working` and `{"items":[{"id":"s1","caption":"…"},…]}` first so the user sees the empty slots, then fill them one by one with `snap asset put <file> --panel stills --slot s1`.
- Generate scene 1 first. Pass it as a reference image to every later scene so they match.
- Look at each result yourself (Read the file). Regenerate once if it's off-style or has garbled text.
- Editor mode: finish with `--status ready --action approve:"Animate these":primary --action redo:"Redo some"`. On `redo`, ask which ones and why.

### 3. Voice (cheap — do it right after the stills are approved, before any clip)
- One narration file per scene, same voice throughout: `voice/<scene>/…`. Measure each with `ffprobe`.
- **The voice sets the length of every scene.** A scene lasts its narration plus about half a second. Anything longer is dead air — the viewer sits watching a finished shot waiting for the next line.
- No panel for this step; one progress line is enough.

### 4. Clips (paid, slow — needs the stills approved)
- Image-to-video from each still, driven by that scene's `motion`, 768P. Duration = narration length + 0.5s, rounded **up** to a whole second, never below the model's minimum. Don't buy seconds the voice won't cover.
- Put the motion early in the prompt ("immediately…"): the end of the clip is what gets trimmed.
- Tell the user the price before you start (clips are the expensive part) and record it with `snap cost add` after. Start them all with `--no-wait`, then collect, sending a progress line per finished scene.
- Same panel pattern as stills, in a `clips` panel: `clips/<scene>/…`, slot = scene id, then `--status ready --action approve:"Cut it together":primary --action redo:"Redo some"`.

### 5. Assembly (free)
- `bun assemble.ts --out final.mp4 s1 s2 s3` — it is in your working directory. It trims every clip to its narration (+0.15s lead, +0.35s breath), slows a clip if the narration outlasts it, normalizes and concatenates. Read its JSON: any scene marked `slowed` deserves a mention. Don't hand-roll ffmpeg for this.
- Check the result before showing it: pull two or three frames with ffmpeg and Read them.
- `snap panel set final --kind video --title "Your video" --status ready --action approve:"I'm happy":primary --action tweak:"Change something"`, attach with `snap asset put final.mp4 --panel final --slot video`, and `snap done --summary "…" --asset <url>`.
- On `tweak`: ask what to change if they haven't said. Redo only what the change touches — a new line means new voice for that scene and a re-cut, not new stills. Re-attach into the same `final` panel.
- On `redo` (stills or clips): ask which ones and what's wrong unless they already told you, redo only those into a fresh folder, re-attach to the same slot, and put the panel back to `ready`.

### Files
Keep everything under the working directory: `script.json`, `stills/<scene>/`, `clips/<scene>/`, `voice/<scene>/`, `final.mp4`. One directory per generation so nothing paid-for gets overwritten.

### Mock mode
Stills: `snap mock image --text "s1 <three words>" -o stills/s1/still.png --size 720x1280` (match the aspect). Voice: `snap mock audio -o voice/s1/line.mp3 --seconds 3`. Clips: `snap mock video … --seconds 4`. Assemble for real with `assemble.ts` — that part is free and is the part worth testing.
