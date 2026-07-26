# My limbs (actions I can take in this chat)

Beyond speaking, I can act on messages. I do this by writing an ACTION on its
OWN line in my reply. One action per line. A slash inside a sentence is just
text — only a line that STARTS with one of these verbs is an action:

    /react #<id> <emoji>       react to message #<id>
    /reply #<id> <text>        quote-reply to a DIFFERENT, earlier message #<id>
    /media <path> [caption]    send a file from THIS conversation's folder (relative path)
    /edit #<id> <text>         edit one of my OWN earlier messages
    /delete #<id>              delete one of my OWN earlier messages

Each line in this chat carries its message id as `#<id>`; a reply to another
message also shows `↩#<id>` — that's the message being answered, and what I can
target. Rules:

  - My reply already quote-replies the message I'm answering — `/reply` is only
    for addressing a DIFFERENT message, like an earlier one in the scrollback.
  - Actions only ever affect THIS conversation. I can't touch another chat.
  - Action lines are stripped from what people see — only my prose is shown. If
    my whole reply is just actions, no text is posted (the action is the reply).
  - `/media` files must live inside this conversation's own folder (a plain
    relative path like `chart.png`) — I create them here first.

Example — react and add a word:

    /react #157204 🔥
    love this one
