# Diffcat 🐈‍⬛

**Compare two PDFs entirely in your browser. Nothing leaves your device.**

**→ https://nipunbatra.github.io/diffcat/**

Drop a draft and its revision — or a preprint and the publisher's typeset
proof — and see every difference. Diffcat is the sibling of
[Redacat](https://nipunbatra.github.io/redacat/) and shares its engine
([MuPDF](https://mupdf.com) compiled to WebAssembly) and its rule: a strict
`Content-Security-Policy` (`default-src 'none'`) makes network requests
impossible, so the page couldn't upload your files even if it wanted to.

## What you get

- **Pages aligned, not just numbered.** Pages are matched by *content* before
  anything is diffed, so an inserted cover page or extra front matter shifts
  the pairing instead of making every later page look "changed". The pairing
  is driven by the whole-document text diff projected back onto pages, with
  word-shingle similarity as a floor and a pixel fallback for pages with no
  text layer. Pages that re-pagination merged into or split off from another
  page are shown *with* that page and labelled `11↝12`; a genuinely unmatched
  page reports how much of its text turned up elsewhere.
- **Side by side** — old and new rendered at the same scale, removed words
  tinted red, added words tinted green, changed regions outlined.
- **Overlay** — both pages blended: red ink exists only in the old file, teal
  only in the new one, dark ink is unchanged.
- **Swipe** — drag a divider across the page.
- **Text** — a whole-document word diff of the *flowing text*. Running heads,
  watermarks, page and margin line numbers, end-of-line hyphenation, and
  dash/quote/ligature variants are stripped; sentences are aligned first
  (patience-anchored, so book-length documents work), then refined word by
  word; passages that merely relocated are shown as **moves**, not edits.
  Diffcat opens re-typeset pairs in this view automatically and says why.
- **Page ranges** — compare *old pages 1–19 with new pages 3–20* to skip a
  metadata sheet, a cover page, or back-matter appendices.
- **A page strip** with thumbnails, colour-coded per page (unchanged /
  changed / re-paginated / only-in-old / only-in-new), so a 50-page contract
  shows you the three pages worth reading.
- **Download report** — a self-contained, printable HTML report: the page map
  and the full text diff. **Page image** saves the current visual view as PNG.

Password-protected PDFs open normally (you'll be asked for the password).
PNG and JPEG images work too; they compare by pixels. Everything works
offline once loaded.

## Running locally / self-hosting

No build step. Serve the directory with any static file server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Everything is vendored — `vendor/mupdf/` contains the prebuilt
[mupdf npm package](https://www.npmjs.com/package/mupdf) (v1.28.0) dist files,
and the one webfont is self-hosted. The site makes zero external requests.

## How the diff works

`js/diff.js` holds the pure algorithms (no DOM, no MuPDF): an LCS word diff,
a block-grid pixel-region detector, a monotone page-alignment DP, the text
flow normaliser, a patience-anchored sequence diff, exact-passage move
detection, and the projection of a document diff back onto pages. `js/app.js`
is the UI. Rendering and text extraction go through the MuPDF WASM engine in
`js/engine.js`.

## Tests

A headless-Chrome end-to-end suite drives the real UI against a local server
on a fixture zoo with *known* differences: a changed word plus an added line, an
inserted cover page (must realign, not cascade), a re-paginated document with a
running head and a hyphenated word (the text view must reduce it to exactly one
changed word), a relocated paragraph (must read as a move), an AES-encrypted
input, mixed-size image pairs, page-range windows (including clamping, swap,
and file replacement), view-mode switching, both downloads, and a privacy test
asserting a whole session makes zero cross-origin requests. A local-only test
on a real preprint-vs-proof pair (kept out of the repo) must reproduce a
hand-checked list of findings. Runs on every push via GitHub Actions.

```sh
cd tests
npm install
node make-fixtures.mjs
node run-tests.mjs                 # local checkout
BASE=https://nipunbatra.github.io/diffcat/ node run-tests.mjs   # live site
```

## License

[AGPL-3.0](LICENSE) — required by the MuPDF engine. Fonts:
[Archivo Black](https://fonts.google.com/specimen/Archivo+Black) (OFL).
