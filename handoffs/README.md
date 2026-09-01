# handoffs/

One file per working session that ends somewhere worth returning to. Newest last
by filename (`YYYY-MM-DD-slug.md`), so the folder reads as the project's history.

A handoff is not a changelog — `git log` is the changelog, and the commit
messages in this repo carry the reasoning. A handoff answers the two questions a
commit cannot: **where are we**, and **what were we in the middle of**. It should
be readable by someone (or some instance) with no memory of the session.

What earns a place in one:

- the shape of the thing as it now stands, if it changed
- decisions and the reason behind them, especially the ones that were reversed
- what is measured versus what is assumed — say which
- open work, with enough detail to act on without re-deriving it
- traps: the things that cost hours, so they cost minutes next time

The four `HANDOFF.*.disposable.md` files at the repo root predate this folder.
They were written to be thrown away; these are not.
