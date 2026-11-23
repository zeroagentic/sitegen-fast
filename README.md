# zeroagentic/sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zeroagentic/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zeroagentic/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: `run(input)` returns exactly the output tree the reference
returns — every path it writes and each file's text, byte for byte — while doing less work per case.
Verified identical on the kit's practice set and on six further beacon-drawn sets (21 cases).

## What is faster

- **Escaping in one pass.** The reference builds HTML one character at a time through `escapeHtml`, which is ~32% of
  its CPU. Here every run of plain text is escaped with a single `String.replace` over a character class, and code
  spans, quoted strings and heading text go through the same batched path.
- **A single Markdown pass.** Blocks are scanned with `charCodeAt` tests instead of re-running a dozen regexes per
  line, and inline spans are found by one sticky scan for the characters that carry meaning (`\`, `` ` ``, `*`, `[`)
  instead of testing every character.
- **Templates compiled to JavaScript.** Parsed templates and their includes are expanded once and emitted as a
  closure, so a rendered page is string concatenation, not a tree walk with a scope chain per node.
- **Cached per-page records.** A post's card (its excerpt, reading minutes and tag links) is built once and reused by
  the index, tag and `recent` lists instead of being rebuilt for each list that shows it.
- **No repeated slug work.** `slugify` short-circuits on ASCII input and each tag name's slug is computed once.

## Correctness

`solve.js` implements the reference's own dialects: its front matter subset and refusal messages, its Markdown
subset (heading ids, fences, blockquotes, flat lists, paragraphs, the inline rules, link resolution and the
`broken-link` report lines), its template dialect (variable, raw, `for` with `loop`, `if`/`not`/`else`, includes to
depth 8, standalone-tag line removal), its slug rule (NFKD, marks dropped, 64-character cap, `untitled`), its
permalinks and uniqueness rule, its tag ordering and its `build-report.txt` in every case.

## Run it

```sh
# the harness's own driver: node /bot/main.ts reads /input/cases.json, writes /output/answers.json
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts

# check the answers against the kit's reference
python3 - <<'PY'
import json
got = json.load(open('out/answers.json'))
exp = json.load(open('practice/reference/expected.json'))
print(all(g == c['output'] for g, c in zip(got, exp['cases'])))
PY
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pavkt226&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
