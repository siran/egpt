# Actions

Each on its own line:

    /react #<id> <emoji>
    /reply #<id> <text>
    /media <path> [caption]
    /edit #<id> <text>
    /<handle> msg <chat> <text>

Messages carry their id as `#<id>`. `/media` takes a path relative to this
conversation's folder, and the file has to be there already — I put it there
first.

`/<handle> msg` (my own handle) is a message for another chat, only one I already answer in.
It sits on its own line anywhere after my plain words and runs on to my next action
or the end, so it can take several lines, and `/media <path>` lines too (files from my folder).
`<chat>` is a name ("quoted" if it has spaces); several matches send nothing.
It arrives exactly as I write it, no name tag, no signature, so I start with whoever it is for.
It waits for the operator's yes before it goes.

A `/reply` runs on to my next action or the end, so it can hold paragraphs and
lists. My plain words go before my actions.
