# Chrome Web Store listing: Graft

Paste each section into the matching field of the Chrome Web Store developer dashboard. The
permission list below is checked against `store/permissions.json` in CI, so it always matches
what the extension asks for. Upload the zip made by `node scripts/store/package-cws.mjs`.

## Name

Graft

## Summary

Ask Graft to do things in your own Chrome, with your tabs and logins, and watch every step it takes.

## Category

Developer Tools

## Description

Graft lets an AI model you choose do real work in your own Chrome: your tabs, your logins, your
sites. You ask in the side panel, and a visible cursor shows every click, scroll and keystroke as
it happens. You can stop it at any time.

What Graft can do:

- Control the browser: open and arrange tabs, read pages, fill forms, click, type, upload and
  download files, and take screenshots.
- Site APIs: learn how a site loads its data, then fetch that data directly next time, so
  repeat tasks are fast and reliable.
- Boosts: small scripts you approve that add a feature or fix to a site you use. They come with
  Graft or you write them yourself, and they run only after you turn them on.
- Side panel and cursor: chat with Graft beside the page and watch the cursor do the work.
  Press Alt+Shift+Space to ask about the page you are on.
- You stay in control: you pick the AI provider and connect your own account. Graft runs on your
  computer, has no server and no tracking, and asks before using extra permissions.

Graft needs its free companion program on your computer. Setup steps:
https://github.com/gillasg/aeon-browser

## Single purpose

Graft lets the user have an AI model of their choice carry out tasks in their own Chrome browser,
with every step visible and under their control.

## Permission justifications

### `nativeMessaging`

Graft's extension talks to the Graft program on the user's own computer, which runs the AI
model the user chose. Every task goes through this local link. Nothing goes to a Graft server;
there is none.

### `storage`

Saves chats, settings and the state of running tasks on the user's computer, so they survive a
browser restart.

### `tabs`

Opens, reads, moves and closes the tabs a task works in, and shows the user which tabs belong to
which chat.

### `sidePanel`

The Graft chat lives in Chrome's side panel, next to the page being worked on.

### `debugger`

This is how Graft acts on a page the way a person would: real mouse and keyboard input,
screenshots, waiting for pages to finish loading, and seeing which network requests a click
caused. It is attached only to tabs a task is using, and Chrome shows its standard banner while
it is attached.

### `contextMenus`

Adds the right-click "Ask Graft" entries for a page, a selection or a link.

### `notifications`

Tells the user when a background task finishes or needs their help, such as a sign-in.

### `userScripts`

Runs Boosts: small scripts that change a site the way the user wants. A Boost runs only after the
user turns it on. Boosts ship inside the extension or are written by the user on their own
computer. Graft never downloads and runs code from a remote server.

### `scripting`

Draws the Graft cursor and highlights on the page, and reads page text for the task the user
asked for.

### `webNavigation`

Waits for a page to finish loading or to fail, so the next step acts on the right page.

### `downloads`

Saves files a task downloads and lists recent downloads when the user asks for them.

### `offscreen`

A hidden extension page used for three things: recording a tab the user asks to record, putting
text on the clipboard for a paste, and reading HTML with Chrome's own parser. It runs no remote
code.

### `tabGroups`

Puts each chat's tabs in their own tab group, so the user can see which tabs a task is using.

### `alarms`

Keeps scheduled tasks and the local link to the Graft program running when Chrome pauses the
extension's background worker.

### `cookies`

Lets a task use the user's existing sign-ins on a site, for example to call that site's own data
API, and saves or restores a site session when the user asks.

### `declarativeNetRequest`

Blocks sites or requests the user does not want a task to reach, and adds the headers a site's
own data API needs.

### `clipboardWrite`

Puts text on the clipboard for a paste step, for editors that only accept pasted text.

### `tabCapture`

Optional, asked for on first use. Records a tab when the user asks for a recording.

### `history`

Optional, asked for on first use. Searches the user's browsing history when they ask, for
example "find the article I read yesterday".

### `bookmarks`

Optional, asked for on first use. Finds, adds or tidies bookmarks when the user asks.

### `contentSettings`

Optional, asked for on first use. Allows or blocks a site's camera, location or notification
prompts during a task the user started.

### `privacy`

Optional, asked for on first use. Turns Chrome's password-saving prompt on or off when the user
chooses Graft's own password vault.

### `clipboardRead`

Optional, asked for on first use. Saves the user's clipboard before a paste step and puts it back
afterwards, so the user's own clipboard is not lost.

### `http://*/*`

The user can ask Graft to work on any site, so Graft needs access to whichever site the task is
on. It acts only on tabs a task is using.

### `https://*/*`

Same reason as above, for secure sites: the user decides which sites a task visits.

## Content script and web-accessible resource

`orb-content.js` runs on pages to draw the small "Ask Graft" bubble (Alt+Shift+Space). `orb.html`
is the bubble's frame and loads only from the extension, using a dynamic URL.

## Remote code

Remote code: No. All code ships inside the extension package. Graft does not load or run
JavaScript or WebAssembly from any server. Boosts are run only from files inside the package or
written by the user on their computer, and only after the user turns them on.

## Data usage

What user data does Graft collect? Tick the following, because Graft handles them on the user's
computer to carry out tasks:

- [x] Personally identifiable information (pages may show the user's name or email)
- [x] Authentication information (existing site sign-ins and cookies, used locally)
- [x] Personal communications (when the user asks for work in email or chat sites)
- [x] Web history (open tabs and, if allowed, history search)
- [x] User activity (clicks and typing that Graft performs for the user)
- [x] Website content (page text and screenshots read for the task)
- [ ] Health information
- [ ] Financial and payment information
- [ ] Location

Certify all three statements:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single
      purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

Note for the "approved use cases" field: page content goes only to the AI provider the user picks
and connects, directly from their computer, to carry out the task they asked for.

## Privacy policy URL

Use the public link to `store/privacy-policy.md` on the default branch:
https://github.com/gillasg/aeon-browser/blob/main/store/privacy-policy.md
