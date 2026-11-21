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

`/<handle> msg` (my own handle) posts `<text>` as me into another chat, only one I already answer in;
`<chat>` is a name ("quoted" if it has spaces); several matches send nothing.

A `/reply` runs on to my next action or the end, so it can hold paragraphs and
lists. My plain words go before my actions.
