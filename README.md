# Readmill

Step through any web page one sentence at a time and leave margin comments, all from
the keyboard (or a foot pedal that sends Tab / Enter). It's the reader from `../latboto`,
turned into a browser extension.

Comments are saved as plain files on your disk, one pair per page:

```
~/notes/web-comments/
  paulgraham-com/
    read-html.json   ← the source of truth; safe to edit by hand
    read-html.md     ← readable copy, rewritten on every change
```

## Setup

1. `./install.sh` registers the storage helper with Chrome, Arc, Brave, Edge, Chromium and Vivaldi
   (whichever you have). Use `READMILL_DIR=~/elsewhere ./install.sh` to change where comments go.
   Re-run it if you move this folder or change Node versions.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `extension/`.

## Use

| Key | |
| --- | --- |
| **Alt+Shift+R** or the toolbar button | turn Readmill on/off for this page |
| **Tab** / **Shift+Tab** | next / previous sentence |
| **Enter** | comment on the highlighted sentence |
| in the comment box: **Tab**, **Enter** | save (Tab cycles Save → Cancel → Delete buttons) |
| **Esc** | close the comment box |
| click / double-click a sentence | select it / comment on it |

Pages you've commented on turn Readmill on by themselves when you come back.
Change shortcuts at `chrome://extensions/shortcuts`.

## How it works

- **`extension/content.js`** finds the page's main text (`<article>`, else `<main>`, else the whole page,
  minus menus, sidebars, footers and forms) and splits it into sentences with `Intl.Segmenter`.
  Sentences are DOM Ranges highlighted with the CSS Custom Highlight API, so the page itself is never
  modified. Readmill's own UI (margin notes, comment box, status pill) sits in a single shadow root.
- **Anchoring:** each comment stores its sentence's text plus a little of the sentences on either side.
  On later visits it's matched back by exact text, then by the surrounding text if the sentence
  appears more than once, then loosely if the page changed slightly. Comments that can't be placed
  show under "unplaced" in the status pill and can be deleted there.
- **`extension/background.js`** passes reads and writes to the native host. If the host can't be
  reached, changes are kept in browser storage and written to disk the next time it answers.
- **`host/readmill-host.js`** is the native messaging host: Chrome starts it for each request; it
  reads and writes the files and exits. No dependencies. You can also run it by hand:
  `host/readmill-host pages`, `host/readmill-host list <url>`.

The extension ID is pinned by the `key` in `manifest.json` (`eagekkfdfbhiacmlocmonbekoicokhlj`),
which is what lets `install.sh` grant that extension access to the host.

## Limits

- Doesn't run on `chrome://` pages, the Chrome Web Store, or PDFs in Chrome's viewer.
- Text inside iframes or other sites' shadow DOM isn't picked up.
- On narrow windows the margin notes overlap the page's right edge.
