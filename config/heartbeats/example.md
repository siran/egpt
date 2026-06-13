<!-- EXAMPLE heartbeat prompt. Copy into a conversation's slug-dir
     (~/.egpt/conversations/<surface>/<slug>/) or a room (~/.egpt/rooms/<name>/)
     as `heartbeat.md`, then enable it in that SAME folder's config.yaml:

        heartbeat:
          enabled: true
          interval_min: 60        # minutes between beats; floor 0.1

     `${time}` is substituted to HH:MM local at fire time. The heartbeat turn is
     dispatched through the SAME confined + bridge-gated path as any reply, so
     the chat's mode (and `paused`) still govern whether anything is sent —
     a heartbeat can never reach a surface a normal reply couldn't. -->

(heartbeat — ${time}) A quiet checkpoint in this conversation.

Skim the recent turns in ./transcript.md. Is there a loose thread you said you'd
follow up on, a question left hanging, or one small thing worth sending now? If
so, send ONE short message in your own voice — no preamble, no "just checking in".
If nothing genuinely needs saying, answer `…` and stay silent (it is logged,
never sent).

If you want to act but aren't sure how — browse the web, find a file saved from
this chat, look back at a past thread — read ./pointers.md first; it maps what
you can do and where things live.
