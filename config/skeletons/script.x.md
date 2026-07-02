<!--
  script.x.md — a TEXTECUTABLE: a plain-text script whose interpreter is one
  Claude turn with tools. This file IS the program. Running it starts a fresh,
  stateless `claude` session that reads the numbered steps below and DOES them,
  working in THIS file's own folder (relative paths in the steps resolve here).

  The `.x.md` double extension is CONSENT — only a file that ends in `.x.md`
  will run; a plain `.md` note is never mistaken for a script.

  Every run appends its result to `script.x.md.log` beside this file.

  How to use it: save this in a conversation folder (a chat's slug dir under
  ~/.egpt/conversations/<surface>/<slug>/, or a room under ~/.egpt/rooms/<name>/),
  then point a heartbeat at it with `ai_run: script.x.md` — see heartbeats.yaml.

  Everything below this comment is the script body — edit it to your task.
-->

1. open chrome over CDP
2. open chatgpt on this conversation
3. copy the contents of this file into chatgpt click send
4. save chatgpt reply as a file
