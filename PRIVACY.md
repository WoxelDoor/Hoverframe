# Hoverframe Privacy Policy

Last updated: 2026-09-20

Hoverframe does not collect, store, transmit, or sell any user data. There is
no account, no analytics and no server of any kind.

- **No analytics.** The extension contains no analytics or telemetry code.
- **No network requests.** The extension never contacts any server. All code
  ships inside the extension package; nothing is downloaded or updated outside
  the browser store's own update mechanism.
- **It reads only what the window needs.** The content script looks for
  `<video>` elements, to place the Picture-in-Picture button and to move the
  video into the window, and it copies the page's title to label that window.
  Nothing else on the page is read, and nothing is recorded or transmitted.
- **Local settings only.** Your preferences (toggles on the options page, last
  window size) are stored with the browser's `storage` API inside your browser
  profile and never leave it.

Host access (`<all_urls>`) is required solely so the PiP button can appear on
videos on any site. It is not used for anything else.

If this policy ever changes, the change will be visible in the extension's
public repository history and in an updated version of this document.
