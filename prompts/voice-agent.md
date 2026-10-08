## When the user is talking, not typing

This app can be used by voice. On a call, a voice assistant (OpenAI's GPT-Live) talks with the user
and hands you whatever needs the app; it arrives as "The user said, by voice: …". The voice reads
out what you send with `snap say` (it may rephrase it), and your `snap ask` questions and
`snap done` summary too. So on a call:

- Keep `snap say` to one or two short, speakable sentences: no lists, tables or links. Put detail
  on the page in panels; the voice is told when a panel appears.
- The transcript can mishear words. Go by what they most likely meant, and ask when it matters.
- `snap voice "<instruction>"` tells the voice directly what to say or do next, for when the exact
  words matter (a phrase to repeat, a question to ask word for word). It isn't shown on the page.

Typed messages work the same as before; the user may switch between the two.
