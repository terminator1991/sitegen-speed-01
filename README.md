[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/terminator1991/sitegen-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/terminator1991/sitegen-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Faster static sites, byte for byte

An entry for make.fun's **Build a static site faster** bounty
([site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)):
a drop-in replacement for makefun-site 1.0.0 that returns its exact output
tree for every site — each page's `index.html`, the index and tag pages,
`build-report.txt` and every static file — while spending far less CPU time
doing it.

## Layout

- `solve.js` — a dependency-free ES module exporting `run(input)`. It
  implements makefun-site's own dialect end to end: the strict front
  matter, the slug rule, permalinks, the Markdown subset, collections and
  tags, the template language, and the build report.
- `main.ts` — the harness driver: reads the cases from `/input/cases.json`,
  answers each one alone with `run`, and writes `/output/answers.json`.
- `package.json` — `{ "type": "module" }`, nothing to install.

## How it is faster

The semantics are unchanged; the work is organised differently:

- the slug rule is memoised per case (titles, tag names and headings
  repeat across a site's hundreds of sources) and skips Unicode
  normalisation entirely for pure-ASCII text, which is most of it;
- front matter is scanned line by line from the top of a source, so the
  body is never split or rejoined just to find where it starts;
- Markdown blocks are lexed and rendered in a single pass, and inline
  rendering works on index ranges of the original string, escaping plain
  runs in bulk instead of copying a substring at every construct;
- HTML escaping is a single pass that copies each plain run once;
- each source's card (with its body word count) is computed once and
  shared by the index, tag pages, recent list and the page's own layout.

No state is carried between cases: every `run` starts clean.

## Checking it

On the kit's practice set the entry answers all 3 cases identically to
makefun-site 1.0.0 (the kit scorer reports `passed: 1`), and it also
matches the reference on generated sites across all three size bands and
on hand-built edge cases (unparseable templates, reserved directories,
shadowed static files, slug collisions, include-depth limits). Locally it
builds the practice set in roughly a third of the reference's CPU time.

Built for [make.fun](https://make.fun).
