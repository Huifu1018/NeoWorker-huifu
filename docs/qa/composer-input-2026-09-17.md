# Composer newline IME and mention menu regression

## Reproduction

The real PromptComposerInput mounted in Chromium reproduced the newline bug:
after committing Chinese, inserting Shift+Enter, and composing `ni` / `nih`
on the next line, the draft became `你好n你好\n` instead of `你好\n你好`.
Chromium inserted the composition before the terminal newline, while the
composition replacement range began after it. The first pinyin character
was therefore left outside the replacement range.

The mention parser also treated a completed `@测试工程师` followed by prose
as an active query. Menu visibility was deferred separately from draft
updates; cursor events could reopen it. Escape keyup reopened a dismissed
menu in the browser regression test.

## Changes

- Add a zero-text-length trailing BR for an editable terminal empty line.
  It does not add characters to the canonical draft or submitted message.
- Preserve identical editable DOM nodes and unchanged selections on refresh.
- Honor native composing flags and non-cancelable input; synchronize
  composition completion in its event rather than a later animation frame.
- Close completed mention queries at the name/whitespace boundary, while
  retaining partial multiword-name search and new `@` queries.
- Synchronize menu visibility with the draft, use the current editor snapshot
  for cursor events, and place the selection immediately after a chosen name.
- Do not reopen autocomplete on Escape keyup.

## Verification

- `node scripts/qa/composer-ime.mjs`: passed. Uses the actual composer and
  MainContent, mocked desktop APIs, and Chromium IME protocol events. Covers
  three consecutive Chinese lines, unchanged DOM/caret, composition commits,
  non-cancelable input, missing compositionstart, mouse/keyboard agent selection,
  continued prose, a fresh `@`, and Escape dismissal.
- Nine related unit suites: 68 tests passed.
- Renderer production build: passed. Diff whitespace check: passed.
- Full project type-check: not passed; errors remain in unrelated app,
  browser API, tests, UI-density types and other modules. This is not a claim
  that the entire repository type-checks.

No installer was built. Automated Chromium composition is not an exhaustive
test of physical macOS/Windows IMEs or third-party input methods. No user
session, document, provider or agent execution was used in these tests.
