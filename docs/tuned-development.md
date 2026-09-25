# Maintaining pi-coder-tuned

Baseline: jayli/pi-coder 2.1.3, commit `d68d965`. The original git history and
license are retained. This fork develops changes directly in `extensions/`;
the snapshot-overwrite procedure in the historical development guide does not
apply here.

## Changes to maintain

- English production literals and matching test expectations.
- `extensions/recap/local.ts`: auto/extract/model selection and pure excerpt extraction.
- `extensions/recap/index.ts`: extraction before auth/completion, English remote prompt.
- `extensions/statusline/line.ts`: exact token counts; empty Git segments omitted.
- Portable test assumptions: skip macOS-only integration on other platforms;
  explicitly select true-color mode for true-color snapshots.

## Verify

```bash
npm install --omit=peer
npm run check:english
PI_TEST_PI_ENTRY=/path/to/pi-coding-agent/dist/index.js npm test
npm pack --dry-run
```

The host supplies Pi packages and typebox; declare these as peer dependencies,
not runtime dependencies. TypeScript is a maintainer-only development dependency
used by the translation audit.

## Upstream merges

Fetch/review upstream commits and merge deliberately; do not overwrite the tree
with a snapshot. `npm run check:english` identifies new untranslated literals.
Add reviewed translations to `tools/english-catalog.json`, run `npm run localize`,
and update test expectations. Chinese comments and multilingual fixtures need not
be translated. Regular expressions that recognize multilingual input must remain
multilingual. Run the full tests and a real Pi extension-load check after merging.

## Release

Bump the fork version, add a changelog entry, review the complete diff and package
contents, then push the source to GitHub. Git installation requires no npm
publication. Users following the default branch update with `pi update --extensions`;
users pinned to a tag/commit must explicitly select a newer ref.
