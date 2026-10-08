## Tool: `rep` — run any Replicate model (images, video, speech, music)

```
rep search "<query>" --json                 find a model
rep schema <owner/name> --json              the inputs it takes — check before the first run of any model
rep run <owner/name> --input-json '{…}' -o <dir> --json [--timeout <sec>]
rep run … --dry-run                         validate the request without spending anything
rep run … --no-wait --json                  returns {id}; collect later with: rep get <id> -o <dir> --json
```

- `--json` puts the result on stdout and logs on stderr. `rep run --json`
  returns `{id, status, model, output, files, metrics, urls}`; with `-o <dir>`,
  **`files` holds the downloaded local paths** — use those.
- File inputs: `-i image=@./local.png` uploads the file. Works inside arrays.
- Video models routinely take 2–5 minutes: pass `--timeout 900`, or use
  `--no-wait` and send progress lines while you poll with `rep get`.
- Give every output its own `-o` directory (e.g. `out/scene-03/`). Reusing one
  directory lets a later run overwrite a file you already paid for.
- Auth comes from `REPLICATE_API_TOKEN`. If it's missing, tell the user; don't hunt for one.

### Models this app uses (checked 2026-09-19)

| job | model | notes |
|---|---|---|
| stills | `minimax/image-01` | confirm inputs with `rep schema` |
| image-to-video | `minimax/h3` | **$0.08 per second at 768P** ($0.13 at 2K). 4–15s. |
| narration | `minimax/speech-2.8-turbo` | `text`, `voice_id`, `speed`, `emotion`; `<#0.5#>` inserts a pause |

`minimax/h3` publishes no input schema, so `rep schema` fails and `rep run` needs `--no-validate`. Its inputs:
`prompt` (required), `first_frame_image` (output takes this image's aspect ratio), `last_frame_image`,
`reference_image_urls` (≤9 public URLs), `duration` (integer 4–15), `resolution` (`"768P"` or `"2K"` — always
pass `"768P"` unless the user asks for more; the default is 2K), `ratio` (only for text-to-video, e.g. `"9:16"`).

```
rep run minimax/h3 --no-validate --timeout 900 -o clips/s1 --json \
  --input-json '{"prompt":"…","first_frame_image":"<url or use -i first_frame_image=@stills/s1/still.png>","duration":5,"resolution":"768P"}'
```
