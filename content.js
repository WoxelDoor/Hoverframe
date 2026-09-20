// Hoverframe content script. Runs in every frame.
//
// Responsibilities:
//  - show a floating PiP button over any usable <video> the cursor is over;
//  - open a Document Picture-in-Picture window, adopt the video into it,
//    build the overlay controls, and wire drag / click-to-pause / aspect
//    snapping through the service worker;
//  - fall back to the native video PiP where the document API is unavailable
//    (cross-origin iframes, older browsers).
//
// The service worker connection is disposable: MV3 workers die after ~30 s of
// silence and kill the port. Every send goes through ensurePort(), which
// reconnects and re-binds the window (the worker is stateless; we cache the
// windowId here and hand it back on "hello"). A 20 s ping keeps the worker
// alive during a PiP session so drags never hit a cold start.

(() => {
  "use strict";
  if (window.__hoverframeLoaded) return;
  window.__hoverframeLoaded = true;

  // Never run inside a Document Picture-in-Picture window (ours or anyone
  // else's): those are top-level about:blank documents. Regular pages are
  // never top-level about:blank, so this is a safe discriminator.
  if (window === window.top && location.href === "about:blank") return;

  // ---------------------------------------------------------------- settings

  const settings = {
    showButton: true,
    clickToPause: true,
    dragAnywhere: true,
    keepAspect: true,
    skipSeconds: 10,
    buttonPosition: "left", // left | top | right | bottom (edge of the video)
  };

  try {
    chrome.storage.sync.get(settings, (stored) => {
      if (!chrome.runtime.lastError) Object.assign(settings, stored);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in settings && newValue !== undefined) settings[key] = newValue;
      }
    });
  } catch {
    // Extension context can be invalidated on update; defaults still work.
  }

  // ----------------------------------------------------------- video finding

  function collectVideos(root, out, depth) {
    if (depth > 4 || !root.querySelectorAll) return;
    for (const v of root.querySelectorAll("video")) out.push(v);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out, depth + 1);
    }
  }

  function allVideos() {
    const out = [];
    collectVideos(document, out, 0);
    return out;
  }

  function isUsable(video) {
    if (!video.isConnected || video.readyState === 0) return false;
    const r = video.getBoundingClientRect();
    return r.width >= 160 && r.height >= 90;
  }

  function videoScore(video) {
    const r = video.getBoundingClientRect();
    const visibleW = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const visibleH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    const visible = Math.max(0, visibleW) * Math.max(0, visibleH);
    let score = visible || r.width * r.height * 0.1;
    if (!video.paused && !video.ended) score *= 4;
    return score;
  }

  function bestVideo() {
    const usable = allVideos().filter(isUsable);
    if (usable.length === 0) return null;
    usable.sort((a, b) => videoScore(b) - videoScore(a));
    return usable[0];
  }

  // ------------------------------------------------------- the hover button

  let button = null;
  let buttonVideo = null;
  let hideTimer = null;

  function ensureButton() {
    if (button) return button;
    button = document.createElement("button");
    button.className = "hoverframe-button";
    button.type = "button";
    button.title = "Watch in Picture-in-Picture";
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M21 4H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H3V6h18v12zm-2-7h-7v5h7v-5z"/>' +
      "</svg><span>PiP</span>";
    button.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (buttonVideo) openPiP(buttonVideo);
      hideButton();
    });
    (document.body || document.documentElement).appendChild(button);
    return button;
  }

  function showButtonFor(video) {
    if (!settings.showButton || document.fullscreenElement) return;
    const btn = ensureButton();
    if (!btn.isConnected) (document.body || document.documentElement).appendChild(btn);
    buttonVideo = video;
    const r = video.getBoundingClientRect();
    const m = 14; // margin from the video edge
    let x, y, tx;
    switch (settings.buttonPosition) {
      case "top":
        x = r.left + r.width / 2; y = r.top + m; tx = "-50%";
        break;
      case "bottom":
        x = r.left + r.width / 2; y = r.bottom - m - 30; tx = "-50%";
        break;
      case "right":
        x = r.right - m; y = r.top + r.height / 2 - 15; tx = "-100%";
        break;
      case "left":
      default:
        x = r.left + m; y = r.top + r.height / 2 - 15; tx = "0";
        break;
    }
    btn.style.left = `${Math.round(x + scrollX)}px`;
    btn.style.top = `${Math.round(y + scrollY)}px`;
    btn.style.transform = `translateX(${tx})`;
    btn.classList.add("hoverframe-button-visible");
    clearTimeout(hideTimer);
  }

  function hideButton() {
    if (!button) return;
    button.classList.remove("hoverframe-button-visible");
    buttonVideo = null;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  let lastMove = 0;
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!settings.showButton) return;
      const now = performance.now();
      if (now - lastMove < 120) return;
      lastMove = now;

      if (button && (e.target === button || button.contains(e.target))) return;

      let hovered = null;
      const over = deepElementFromPoint(e.clientX, e.clientY);
      for (const v of allVideos()) {
        if (!isUsable(v)) continue;
        const r = v.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          hovered = v;
          if (over && (v === over || v.parentElement?.contains(over))) break;
        }
      }
      if (hovered) {
        showButtonFor(hovered);
      } else if (buttonVideo) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideButton, 300);
      }
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    "scroll",
    () => {
      if (buttonVideo) hideButton();
    },
    { passive: true, capture: true }
  );

  // --------------------------------------------------------------- messaging

  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "hoverframe-report") {
      const v = bestVideo();
      if (v) {
        chrome.runtime.sendMessage({ type: "hoverframe-candidate", score: videoScore(v) }).catch(() => {});
      }
      sendResponse({});
    } else if (msg?.type === "hoverframe-open-best") {
      const v = bestVideo();
      if (v) openPiP(v);
      sendResponse({});
    }
    return false;
  });

  // ----------------------------------------------------------- iframe handoff
  //
  // Document Picture-in-Picture is available only to a page's TOP-LEVEL
  // document, so a frame can never open the window itself. It asks upward
  // instead: every frame passes the request to its parent together with the
  // <iframe> element the request arrived through, so the top frame ends up
  // holding an element of its own. From there:
  //
  //   same origin  - reach in, adopt the real <video>. Adoption across
  //                  browsing contexts reloads the element, so the position is
  //                  put back afterwards.
  //   cross origin - move the <iframe> element itself into the window. It
  //                  reloads once; our content script runs inside it there and
  //                  becomes the control channel.
  //
  // Native PiP stays only as the last resort, when nobody upstream answers.

  const HF = "__hoverframe";

  function childFrameElement(sourceWindow) {
    const frames = [];
    collectFrames(document, frames, 0);
    for (const el of frames) {
      try {
        if (el.contentWindow === sourceWindow) return el;
      } catch {}
    }
    return null;
  }

  function collectFrames(root, out, depth) {
    if (depth > 4 || !root.querySelectorAll) return;
    for (const el of root.querySelectorAll("iframe, frame")) out.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectFrames(el.shadowRoot, out, depth + 1);
    }
  }

  // Asked from inside a frame. Falls back to native PiP only if nothing
  // upstream takes the job.
  function requestTakeover(video) {
    let parentWindow = null;
    try {
      parentWindow = window.parent;
    } catch {}
    if (!parentWindow || parentWindow === window) return fallbackNativePiP(video);

    const token = Math.random().toString(36).slice(2);
    let answered = false;
    function onReply(e) {
      const d = e.data;
      if (!d || d.token !== token) return;
      if (d[HF] === "taken") {
        answered = true;
        window.removeEventListener("message", onReply);
      } else if (d[HF] === "declined") {
        // Nobody up there can reach this video - a cross-origin frame. The
        // browser's own picture-in-picture is the honest answer, and asking
        // for it now keeps the click's user activation.
        answered = true;
        window.removeEventListener("message", onReply);
        fallbackNativePiP(video);
      }
    }
    window.addEventListener("message", onReply);
    try {
      parentWindow.postMessage(
        {
          [HF]: "take",
          token,
          t: video.currentTime,
          paused: video.paused,
          ratio:
            video.videoWidth > 0 && video.videoHeight > 0
              ? video.videoWidth / video.videoHeight
              : 0,
        },
        "*"
      );
    } catch {
      window.removeEventListener("message", onReply);
      return fallbackNativePiP(video);
    }
    setTimeout(() => {
      window.removeEventListener("message", onReply);
      if (!answered) fallbackNativePiP(video);
    }, 800);
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d[HF] !== "take") return;
    const frameEl = childFrameElement(e.source);
    if (!frameEl) return; // not one of our own frames

    if (window === window.top) {
      const inner = reachableFrameVideo(frameEl);
      try {
        e.source.postMessage(
          { [HF]: inner ? "taken" : "declined", token: d.token }, "*");
      } catch {}
      if (inner) openPiP(inner);
      return;
    }
    // Not the top yet: hand it on, and relay the answer back down. The element
    // the top frame ends up with is OUR frame, which contains the whole chain.
    const upToken = Math.random().toString(36).slice(2);
    function onUp(ev) {
      const u = ev.data;
      if (!u || u.token !== upToken) return;
      if (u[HF] !== "taken" && u[HF] !== "declined") return;
      window.removeEventListener("message", onUp);
      try {
        e.source.postMessage({ [HF]: u[HF], token: d.token }, "*");
      } catch {}
    }
    window.addEventListener("message", onUp);
    try {
      window.parent.postMessage({ ...d, token: upToken }, "*");
    } catch {
      window.removeEventListener("message", onUp);
    }
  });

  // The <video> inside a frame, when the browser lets us have it at all. A
  // cross-origin frame throws or hands back nothing, and that is the whole
  // test: what cannot be reached cannot be driven, so it is not taken over.
  function reachableFrameVideo(frameEl) {
    try {
      const doc = frameEl.contentDocument;
      if (!doc) return null;
      const vids = [];
      collectVideos(doc, vids, 0);
      return (
        vids
          .filter((v) => v.readyState > 0)
          .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] || null
      );
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- PiP window

  let active = null; // current session state

  async function openPiP(video) {
    if (active) {
      try {
        active.pipWindow.close();
      } catch {}
      active = null;
    }

    if (!("documentPictureInPicture" in window)) {
      return fallbackNativePiP(video);
    }
    // A video inside a frame cannot open the window from there - hand it to
    // the top frame, which can. Native PiP if it cannot reach the video.
    if (window !== window.top) {
      return requestTakeover(video);
    }

    const ratio =
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : 16 / 9;

    let innerW = 0;
    try {
      const stored = await chrome.storage.local.get("lastPipWidth");
      innerW = stored.lastPipWidth || 0;
    } catch {}
    if (!innerW) innerW = Math.round(screen.availWidth * 0.28);
    innerW = Math.min(Math.max(innerW, 320), Math.round(screen.availWidth * 0.8));
    const innerH = Math.round(innerW / ratio);

    const state = {
      video,
      ratio,
      pipWindow: null,
      port: null,
      bound: false,
      windowId: null, // cached across worker restarts
      queuedMove: null,
      queuedSnap: null,
      pingTimer: null,
      closed: false,
    };

    // ---- disposable service worker connection ----

    function ensurePort(firstMessage) {
      if (state.port) return state.port;
      let port;
      try {
        port = chrome.runtime.connect({ name: "hoverframe" });
      } catch {
        return null; // extension updated/removed; PiP keeps working minus drag
      }
      state.port = port;
      state.bound = false;
      port.onMessage.addListener((msg) => {
        if (msg.t === "bound") {
          state.bound = true;
          if (msg.windowId != null) state.windowId = msg.windowId;
          if (state.queuedMove) {
            post(state.queuedMove);
            state.queuedMove = null;
          }
          if (state.queuedSnap) {
            post(state.queuedSnap);
            state.queuedSnap = null;
          }
        } else if (msg.t === "dragBase") {
          state.onDragBase?.(msg);
        }
      });
      port.onDisconnect.addListener(() => {
        if (state.port === port) {
          state.port = null;
          state.bound = false;
        }
      });
      if (firstMessage) port.postMessage(firstMessage);
      if (state.pipWindow && firstMessage?.t !== "opening") {
        port.postMessage(helloMessage());
      }
      return port;
    }

    function helloMessage() {
      const w = state.pipWindow;
      return {
        t: "hello",
        windowId: state.windowId,
        screenX: w.screenX,
        screenY: w.screenY,
        outerW: w.outerWidth,
        outerH: w.outerHeight,
        innerW: w.innerWidth,
        innerH: w.innerHeight,
        ratio: currentRatio(),
      };
    }

    function post(msg) {
      const port = ensurePort();
      if (!port) return;
      if (!state.bound && (msg.t === "move" || msg.t === "snap")) {
        // Not re-bound yet after a reconnect: remember only the latest.
        if (msg.t === "move") state.queuedMove = msg;
        else state.queuedSnap = msg;
        return;
      }
      try {
        port.postMessage(msg);
      } catch {
        state.port = null;
      }
    }

    function currentRatio() {
      return state.video.videoWidth > 0 && state.video.videoHeight > 0
        ? state.video.videoWidth / state.video.videoHeight
        : state.ratio;
    }

    ensurePort({ t: "opening" });

    let pipWindow;
    try {
      pipWindow = await documentPictureInPicture.requestWindow({
        width: innerW,
        height: innerH,
      });
    } catch (err) {
      try {
        state.port?.disconnect();
      } catch {}
      return fallbackNativePiP(video);
    }

    state.pipWindow = pipWindow;
    buildPipDocument(state, post);
    active = state;

    state.port?.postMessage({
      t: "opened",
      windowId: null,
      innerW: pipWindow.innerWidth,
      innerH: pipWindow.innerHeight,
      outerW: pipWindow.outerWidth,
      outerH: pipWindow.outerHeight,
      screenX: pipWindow.screenX,
      screenY: pipWindow.screenY,
      ratio,
      baseW: pipWindow.innerWidth,
      baseH: pipWindow.innerHeight,
    });

    // Keep the worker warm for the whole session so a drag never waits for a
    // cold start. The ping itself resets the worker's 30 s idle timer.
    state.pingTimer = setInterval(() => post({ t: "ping" }), 20000);
  }

  function fallbackNativePiP(video) {
    try {
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {});
      } else {
        video.requestPictureInPicture().catch(() => {});
      }
    } catch {}
  }

  // ------------------------------------------------- PiP document construction

  const PIP_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%; overflow: hidden; background: #000;
      font-family: "Segoe UI", system-ui, sans-serif;
      -webkit-user-select: none; user-select: none;
    }
    .stage { position: relative; width: 100%; height: 100%; cursor: default; }
    .stage video {
      width: 100% !important; height: 100% !important;
      max-width: none !important; max-height: none !important;
      position: static !important; transform: none !important;
      object-fit: contain; background: #000; pointer-events: none;
    }

    .flash {
      position: absolute; left: 50%; top: 50%;
      width: 92px; height: 92px; margin: -46px 0 0 -46px;
      border-radius: 50%; background: rgba(20, 20, 20, 0.65);
      display: flex; align-items: center; justify-content: center;
      color: #fff; opacity: 0; pointer-events: none; transform: scale(0.8);
    }
    .flash.animate { animation: hoverframe-flash 0.45s ease-out forwards; }
    @keyframes hoverframe-flash {
      0% { opacity: 0.9; transform: scale(0.8); }
      100% { opacity: 0; transform: scale(1.25); }
    }
    .flash svg { width: 46px; height: 46px; }

    /* Overlays: hidden until hover. */
    .topbar {
      position: absolute; left: 0; right: 0; top: 0;
      display: flex; align-items: flex-start; gap: 8px;
      padding: 10px 10px 28px 16px;
      background: linear-gradient(rgba(0, 0, 0, 0.6), transparent);
      opacity: 0; transition: opacity 0.18s ease;
    }
    .stage:hover .topbar { opacity: 1; }

    .title {
      flex: 1; color: #eee; font-size: 16px; font-weight: 600;
      line-height: 36px; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
      pointer-events: none;
    }
    .topbar button {
      background: none; border: none; color: #e8e8e8; cursor: pointer;
      width: 40px; height: 36px; border-radius: 8px; flex: none;
      display: flex; align-items: center; justify-content: center;
    }
    .topbar button:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
    .topbar svg { width: 24px; height: 24px; fill: currentColor; }

    .controls {
      position: absolute; left: 0; right: 0; bottom: 0;
      padding: 32px 12px 8px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.72));
      opacity: 0; transition: opacity 0.18s ease; cursor: default;
    }
    .stage:hover .controls { opacity: 1; }

    .seek-row { display: flex; align-items: center; margin-bottom: 5px; }
    .seek {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 18px; background: transparent; cursor: pointer;
    }
    .seek::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right,
        #ffcc00 var(--progress, 0%), rgba(255, 255, 255, 0.3) var(--progress, 0%));
      transition: height 0.12s ease;
    }
    .seek:hover::-webkit-slider-runnable-track { height: 7px; }
    .seek::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; margin-top: -5px; border-radius: 50%;
      background: #ffcc00; transform: scale(0);
      transition: transform 0.12s ease;
    }
    .seek:hover::-webkit-slider-thumb { transform: scale(1); margin-top: -3.5px; }

    .buttons { display: flex; align-items: center; gap: 3px; }
    .buttons button {
      background: none; border: none; color: #e8e8e8; cursor: pointer;
      width: 42px; height: 36px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font: 600 15px/1 "Segoe UI", system-ui, sans-serif;
    }
    .buttons button:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
    .buttons svg { width: 26px; height: 26px; fill: currentColor; }
    .buttons .skip svg { width: 28px; height: 28px; }

    .time {
      color: #ddd; font-size: 15px; margin: 0 8px; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .spacer { flex: 1; }
    .speed { min-width: 52px; font-size: 15px; }

    .vol-wrap { display: flex; align-items: center; }
    .vol {
      -webkit-appearance: none; appearance: none;
      width: 0; height: 16px; background: transparent; cursor: pointer;
      transition: width 0.15s ease; overflow: hidden;
    }
    .vol-wrap:hover .vol, .vol:active { width: 72px; }
    .vol::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right,
        #fff var(--vol, 100%), rgba(255, 255, 255, 0.3) var(--vol, 100%));
    }
    .vol::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 13px; height: 13px; margin-top: -4.5px; border-radius: 50%;
      background: #fff;
    }

    /* Mirrored captions. Sized in vw so they scale with the window, and
       lifted clear of the controls while those are shown. */
    .captions {
      position: absolute; left: 0; right: 0; bottom: 6%;
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 0 5%; text-align: center; pointer-events: none;
      transition: bottom 0.18s ease;
    }
    .stage:hover .captions { bottom: 64px; }
    .captions span {
      display: inline-block; max-width: 100%;
      background: rgba(0, 0, 0, 0.78); color: #fff;
      font-size: clamp(12px, 3.4vw, 30px); line-height: 1.34;
      padding: 1px 8px; border-radius: 3px; white-space: pre-wrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    }
    .buttons .cc { display: none; }
    .buttons .cc.present { display: flex; }
    .buttons .cc.off { color: #8b8b8b; }

    .build {
      color: #9a9a9a; font-size: 12px; line-height: 36px; padding: 0 4px;
      flex: none; pointer-events: none; white-space: nowrap;
    }
  `;

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
    back10:
      '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/><text x="8.2" y="16.5" font-size="7" font-weight="bold" fill="currentColor" stroke="none">10</text></svg>',
    fwd10:
      '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/><text x="8.2" y="16.5" font-size="7" font-weight="bold" fill="currentColor" stroke="none">10</text></svg>',
    volHigh:
      '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z"/></svg>',
    volMuted:
      '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.8-1-3.3-2.5-4v2.2l2.5 2.5V12zM19 12c0 .9-.2 1.8-.5 2.6l1.5 1.5c.7-1.2 1-2.6 1-4.1 0-4.3-3-7.9-7-8.8v2.1c2.9.9 5 3.5 5 6.7zM4.3 3L3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3c-.7.5-1.4.9-2.3 1.2v2.1c1.4-.3 2.6-.9 3.7-1.8l2 2L21 19.7 4.3 3zM12 4L9.9 6.1 12 8.2V4z"/></svg>',
    backToTab:
      '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7z"/></svg>',
    close:
      '<svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
    fsEnter:
      '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    fsExit:
      '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
    cc:
      '<svg viewBox="0 0 24 24"><path d="M19 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1v-4c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .6-.4 1-1 1h-3c-.6 0-1-.4-1-1v-4c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1z"/></svg>',
  };

  function formatTime(t) {
    if (!isFinite(t)) return "live";
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------------------------------------------------------------- captions
  //
  // <video> is a replaced element: anything written between its tags is
  // fallback content the browser never renders. A site's caption layer is
  // therefore always a SIBLING drawn on top, never a descendant - so adopting
  // the video into the PiP window cannot take it along, on any site. The fix
  // is to mirror: watch the site's caption box in the page and copy its text
  // into a layer of our own over the video in the window.
  //
  // <track> cues are the exception. The browser lays those out inside the
  // media element's own box, so they travel with the element and only need
  // their mode flipped.

  // `lines` is tried in order and the first selector that matches anything
  // wins. It must not be one combined selector: YouTube nests
  // .captions-text > .caption-visual-line > .ytp-caption-segment, so matching
  // lines and segments together returns every line twice, once whole and once
  // in pieces. Shape taken from Mozilla's shipping wrapper.
  const CAPTION_SITES = [
    {
      host: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/,
      // An id, not a class - the container sits beside the video in #movie_player.
      container: "#ytp-caption-window-container",
      lines: [".captions-text .caption-visual-line", ".caption-visual-line", ".ytp-caption-segment"],
    },
    {
      host: /(^|\.)netflix\.com$/,
      container: ".player-timedtext",
      lines: [".player-timedtext-text-container"],
    },
  ];

  // Last resort where no rule matches. Deliberately narrow: a wrong guess puts
  // stray page text over the picture, which is worse than no captions.
  const GENERIC_CAPTION_SELECTOR =
    '[class*="caption" i]:not([class*="button" i]):not([class*="icon" i]):not([class*="menu" i]),' +
    '[class*="subtitle" i]:not([class*="button" i]):not([class*="menu" i]),' +
    '[class*="timedtext" i]';

  // `anchor` must be a node that is still in the PAGE. The video itself is
  // not: by the time captions are set up it has been adopted into the PiP
  // document, and walking up from it climbs the wrong tree. The placeholder
  // comment left behind in the page is the right starting point.
  function findCaptionBox(anchor) {
    for (const site of CAPTION_SITES) {
      if (!site.host.test(location.hostname)) continue;
      const box = document.querySelector(site.container);
      if (box) return { box, lines: site.lines };
    }
    let fallback = null;
    let root = anchor && anchor.parentElement;
    for (let i = 0; i < 5 && root; i++, root = root.parentElement) {
      for (const cand of root.querySelectorAll(GENERIC_CAPTION_SELECTOR)) {
        if (!fallback) fallback = cand;
        if ((cand.textContent || "").trim()) return { box: cand, lines: null };
      }
    }
    return fallback ? { box: fallback, lines: null } : null;
  }

  function readCaptionLines(box, lineSelectors) {
    let nodes = [];
    for (const selector of lineSelectors || []) {
      nodes = box.querySelectorAll(selector);
      if (nodes.length) break;
    }
    const sources = nodes.length ? Array.from(nodes) : [box];
    const lines = [];
    for (const node of sources) {
      // innerText carries the rendered line breaks, which is what splits a
      // multi-line cue when no per-line selector matched. It comes back empty
      // for a container the site has collapsed, so textContent is the fallback.
      const raw = (node.innerText || node.textContent || "").trim();
      if (!raw) continue;
      for (const piece of raw.split("\n")) {
        const text = piece.trim();
        // No dedup: the selectors are tried in order, so a line and the
        // segments inside it can never both match, and a cue is allowed to
        // repeat the same words on two lines.
        if (text) lines.push(text);
      }
    }
    return lines;
  }

  // Returns the caption controller for one PiP session. `reveal` is called the
  // first time real captions exist, so the CC button can stay hidden on a
  // video that has none.
  function createCaptions(video, anchor, doc, stage, reveal) {
    const layer = doc.createElement("div");
    layer.className = "captions";
    stage.appendChild(layer);

    let enabled = true;
    let revealed = false;
    let found = findCaptionBox(anchor);
    let observer = null;
    let paintTimer = 0;
    let recheckTimer = 0;
    let dead = false;

    function subtitleTracks() {
      const out = [];
      try {
        for (const t of video.textTracks || []) {
          if (t.kind === "subtitles" || t.kind === "captions") out.push(t);
        }
      } catch {}
      return out;
    }
    // Remember which track the site had showing, so the toggle can put it back.
    let shownTrack = subtitleTracks().find((t) => t.mode === "showing") || null;

    function announce() {
      if (revealed) return;
      revealed = true;
      try {
        reveal();
      } catch {}
    }

    function paint(lines) {
      layer.textContent = "";
      if (!enabled || !lines.length) return;
      for (const line of lines) {
        const span = doc.createElement("span");
        span.textContent = line;
        layer.appendChild(span);
      }
    }

    function pull() {
      if (dead || !found) return;
      if (!found.box.isConnected) {
        // The site rebuilt its caption box - look for the new one.
        found = findCaptionBox(anchor);
        attach();
        return;
      }
      const lines = readCaptionLines(found.box, found.lines);
      if (lines.length) announce();
      paint(lines);
    }

    function schedule() {
      if (paintTimer) return;
      paintTimer = setTimeout(() => {
        paintTimer = 0;
        pull();
      }, 60);
    }

    function attach() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (!found) return;
      observer = new MutationObserver(schedule);
      observer.observe(found.box, { childList: true, subtree: true, characterData: true });
      pull();
    }

    if (shownTrack) announce();
    attach();

    // A site may only build its caption box once the viewer turns captions on,
    // which can happen after the window is already open.
    recheckTimer = setInterval(() => {
      if (dead) return;
      if (!shownTrack) {
        shownTrack = subtitleTracks().find((t) => t.mode === "showing") || null;
        if (shownTrack) announce();
      }
      if (!found || !found.box.isConnected) {
        found = findCaptionBox(anchor);
        if (found) attach();
      }
    }, 1000);

    return {
      get enabled() {
        return enabled;
      },
      setEnabled(on) {
        enabled = !!on;
        if (shownTrack) {
          try {
            shownTrack.mode = enabled ? "showing" : "hidden";
          } catch {}
        }
        if (!enabled) layer.textContent = "";
        else pull();
      },
      destroy() {
        dead = true;
        clearInterval(recheckTimer);
        clearTimeout(paintTimer);
        if (observer) observer.disconnect();
        layer.remove();
        // Leave the site's own track exactly as it was found.
        if (shownTrack) {
          try {
            shownTrack.mode = "showing";
          } catch {}
        }
      },
    };
  }

  function buildPipDocument(state, post) {
    const { pipWindow, video } = state;
    const doc = pipWindow.document;
    doc.title = document.title || "Hoverframe";

    const style = doc.createElement("style");
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);

    const restoreInfo = {
      placeholder: document.createComment("hoverframe-placeholder"),
      styleAttr: video.getAttribute("style"),
      controlsAttr: video.controls,
      wasTime: video.currentTime,
      wasPaused: video.paused,
    };
    video.before(restoreInfo.placeholder);

    const stage = doc.createElement("div");
    stage.className = "stage";
    doc.body.appendChild(stage);

    stage.appendChild(video);
    video.controls = false;
    video.removeAttribute("controlslist");

    if (restoreInfo.wasTime > 0.5) {
      // Adopting a video OUT OF A FRAME reloads it; adopting one from this
      // document does not. Arm the restore either way - it only fires if a
      // reload really happened.
      const putBack = () => {
        try {
          if (video.currentTime < restoreInfo.wasTime - 1) {
            video.currentTime = restoreInfo.wasTime;
          }
        } catch {}
        if (!restoreInfo.wasPaused) video.play().catch(() => {});
      };
      video.addEventListener("loadedmetadata", putBack, { once: true });
      setTimeout(() => video.removeEventListener("loadedmetadata", putBack), 6000);
    }

    const flash = doc.createElement("div");
    flash.className = "flash";
    stage.appendChild(flash);

    // Top overlay on the video itself: title + back-to-tab + close, the
    // Yandex layout. (The browser's own strip above the video shows the site
    // origin and cannot be renamed or removed - that part is security UI.)
    const topbar = doc.createElement("div");
    topbar.className = "topbar";
    let buildTag = "";
    try {
      buildTag = chrome.runtime.getManifest().version || "";
    } catch {}
    topbar.innerHTML = `
      <span class="title"></span>
      <span class="build">${buildTag}</span>
      <button class="to-tab" title="Back to tab">${ICONS.backToTab}</button>
      <button class="close" title="Close">${ICONS.close}</button>
    `;
    topbar.querySelector(".title").textContent = document.title || location.hostname;
    stage.appendChild(topbar);

    const controls = doc.createElement("div");
    controls.className = "controls";
    controls.innerHTML = `
      <div class="seek-row">
        <input class="seek" type="range" min="0" max="1000" step="1" value="0" title="Seek">
      </div>
      <div class="buttons">
        <button class="playpause" title="Play/Pause (Space)">${ICONS.pause}</button>
        <button class="skip back" title="Back ${settings.skipSeconds}s">${ICONS.back10}</button>
        <button class="skip fwd" title="Forward ${settings.skipSeconds}s">${ICONS.fwd10}</button>
        <span class="time">0:00 / 0:00</span>
        <span class="spacer"></span>
        <button class="cc" title="Subtitles (C)">${ICONS.cc}</button>
        <button class="speed" title="Playback speed">1&times;</button>
        <div class="vol-wrap">
          <button class="mute" title="Mute (M)">${ICONS.volHigh}</button>
          <input class="vol" type="range" min="0" max="100" step="1" value="100" title="Volume">
        </div>
        <button class="fullscreen" title="Fullscreen (F)">${ICONS.fsEnter}</button>
      </div>
    `;
    stage.appendChild(controls);

    const el = {
      playpause: controls.querySelector(".playpause"),
      back: controls.querySelector(".back"),
      fwd: controls.querySelector(".fwd"),
      time: controls.querySelector(".time"),
      speed: controls.querySelector(".speed"),
      cc: controls.querySelector(".cc"),
      mute: controls.querySelector(".mute"),
      vol: controls.querySelector(".vol"),
      seek: controls.querySelector(".seek"),
      fullscreen: controls.querySelector(".fullscreen"),
      toTab: topbar.querySelector(".to-tab"),
      close: topbar.querySelector(".close"),
    };

    // ------------------------------------------------ playback control logic

    function togglePlay() {
      if (video.paused || video.ended) {
        video.play().catch(() => {});
        showFlash(ICONS.play);
      } else {
        video.pause();
        showFlash(ICONS.pause);
      }
    }

    function showFlash(icon) {
      flash.innerHTML = icon;
      flash.classList.remove("animate");
      void flash.offsetWidth;
      flash.classList.add("animate");
    }

    function seekBy(delta) {
      holdVolume();
      try {
        video.currentTime = Math.min(
          Math.max(0, video.currentTime + delta),
          video.duration || video.currentTime + delta
        );
      } catch {}
    }

    // What the viewer asked for in THIS window. `on` stays false until they
    // touch the volume here, so the site is never fought with over a value
    // nobody chose.
    const wantedVolume = { volume: video.volume, muted: video.muted, on: false };

    // Always through here. Writing to video.volume fires volumechange
    // synchronously, and that handler enforces `wantedVolume` - so the wanted
    // value has to be updated BEFORE the write, or the guard reverts the
    // change it exists to protect.
    function setVolume(volume, muted) {
      wantedVolume.volume = Math.min(1, Math.max(0, volume));
      wantedVolume.muted = !!muted;
      wantedVolume.on = true;
      try {
        video.muted = wantedVolume.muted;
        video.volume = wantedVolume.volume;
      } catch {}
    }

    function enforceVolume() {
      if (!wantedVolume.on) return;
      try {
        if (Math.abs(video.volume - wantedVolume.volume) > 0.01) {
          video.volume = wantedVolume.volume;
        }
        if (video.muted !== wantedVolume.muted) video.muted = wantedVolume.muted;
      } catch {}
    }

    // A seek is where the player reasserts itself, and it does it a moment
    // later rather than synchronously.
    function holdVolume() {
      if (!wantedVolume.on) return;
      for (const delay of [0, 250, 800, 1800]) setTimeout(enforceVolume, delay);
    }

    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    function cycleSpeed() {
      const i = SPEEDS.findIndex((s) => s >= video.playbackRate - 0.01);
      const next = SPEEDS[(i + 1) % SPEEDS.length] ?? 1;
      video.playbackRate = next;
    }

    // ------------------------------------------------------------ UI updates

    function refreshPlayButton() {
      el.playpause.innerHTML = video.paused || video.ended ? ICONS.play : ICONS.pause;
    }

    function refreshTime() {
      el.time.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
      if (isFinite(video.duration) && video.duration > 0) {
        const p = (video.currentTime / video.duration) * 1000;
        if (!state.seeking) el.seek.value = String(p);
        el.seek.style.setProperty("--progress", `${p / 10}%`);
        el.seek.disabled = false;
      } else {
        el.seek.disabled = true;
        el.seek.style.setProperty("--progress", "0%");
      }
    }

    function refreshVolume() {
      el.mute.innerHTML = video.muted || video.volume === 0 ? ICONS.volMuted : ICONS.volHigh;
      const v = video.muted ? 0 : Math.round(video.volume * 100);
      el.vol.value = String(v);
      el.vol.style.setProperty("--vol", `${v}%`);
    }

    function refreshSpeed() {
      const r = Math.round(video.playbackRate * 100) / 100;
      el.speed.innerHTML = `${r}&times;`;
    }

    const videoEvents = {
      play: refreshPlayButton,
      pause: refreshPlayButton,
      ended: refreshPlayButton,
      timeupdate: refreshTime,
      durationchange: refreshTime,
      loadedmetadata: refreshTime,
      volumechange: () => {
        enforceVolume();
        refreshVolume();
      },
      loadstart: enforceVolume,
      canplay: enforceVolume,
      playing: enforceVolume,
      ratechange: refreshSpeed,
    };
    for (const [ev, fn] of Object.entries(videoEvents)) video.addEventListener(ev, fn);

    refreshPlayButton();
    refreshTime();
    refreshVolume();
    refreshSpeed();

    // -------------------------------------------------------- control wiring

    el.playpause.addEventListener("click", togglePlay);
    el.back.addEventListener("click", () => seekBy(-settings.skipSeconds));
    el.fwd.addEventListener("click", () => seekBy(settings.skipSeconds));
    el.speed.addEventListener("click", cycleSpeed);
    el.mute.addEventListener("click", () => {
      setVolume(video.volume, !video.muted);
    });
    el.vol.addEventListener("input", () => {
      setVolume(Number(el.vol.value) / 100, false);
    });
    el.seek.addEventListener("pointerdown", () => (state.seeking = true));
    el.seek.addEventListener("pointerup", () => (state.seeking = false));
    el.seek.addEventListener("input", () => {
      holdVolume();
      if (isFinite(video.duration)) {
        try {
          video.currentTime = (Number(el.seek.value) / 1000) * video.duration;
        } catch {}
      }
    });
    el.toTab.addEventListener("click", () => {
      post({ t: "backToTab" });
      try {
        pipWindow.close();
      } catch {}
    });
    el.close.addEventListener("click", () => {
      try {
        pipWindow.close();
      } catch {}
    });

    // ----------------------------------------------------------- captions

    const captions = createCaptions(video, restoreInfo.placeholder, doc, stage, () => {
      el.cc.classList.add("present");
    });
    state.captions = captions;

    // The last choice is remembered, so someone who never wants captions is
    // not asked again every time a window opens.
    try {
      chrome.storage.local.get({ captionsOn: true }, (stored) => {
        if (chrome.runtime.lastError) return;
        captions.setEnabled(stored.captionsOn !== false);
        el.cc.classList.toggle("off", !captions.enabled);
      });
    } catch {}

    function toggleCaptions() {
      captions.setEnabled(!captions.enabled);
      el.cc.classList.toggle("off", !captions.enabled);
      try {
        chrome.storage.local.set({ captionsOn: captions.enabled });
      } catch {}
    }

    el.cc.addEventListener("click", toggleCaptions);

    // Clicks on the controls must not reach the stage (drag / click-to-pause).
    // The top strip is different: only its buttons swallow the pointer, so the
    // strip itself stays a place to drag the window by - which is the only
    // handle left once an unreachable player has taken the pointer back.
    for (const overlay of [controls, ...topbar.querySelectorAll("button")]) {
      overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
      overlay.addEventListener("pointerup", (e) => e.stopPropagation());
      overlay.addEventListener("click", (e) => e.stopPropagation());
    }

    // --------------------------------------- drag anywhere + click to pause

    const DRAG_THRESHOLD = 5;
    let drag = null;

    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = {
        startX: e.screenX,
        startY: e.screenY,
        // Window position comes from the worker (windows.get): the
        // renderer-side window.screenX can be stale right after the window
        // was moved or restored programmatically. Until it arrives, deltas
        // are buffered. This also wakes the worker so the drag has no cold
        // start.
        winX: null,
        winY: null,
        lastDx: 0,
        lastDy: 0,
        moved: false,
        pointerId: e.pointerId,
      };
      const thisDrag = drag;
      state.onDragBase = (msg) => {
        if (drag !== thisDrag) return;
        drag.winX = msg.left;
        drag.winY = msg.top;
        if (drag.moved) {
          post({ t: "move", left: drag.winX + drag.lastDx, top: drag.winY + drag.lastDy });
        }
      };
      post({ t: "dragStart" });
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {}
    });

    stage.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      drag.lastDx = dx;
      drag.lastDy = dy;
      if (settings.dragAnywhere && !expanded && drag.winX != null) {
        post({ t: "move", left: drag.winX + dx, top: drag.winY + dy });
      }
    });

    stage.addEventListener("pointerup", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const wasClick = !drag.moved;
      drag = null;
      if (wasClick && settings.clickToPause) togglePlay();
    });

    stage.addEventListener("pointercancel", () => (drag = null));

    // ------------------------------------------------------- aspect snapping
    //
    // Live: during an interactive border drag, the axis the user is dragging
    // is locked once per gesture (first ~8 px decide it) and only the OTHER
    // dimension is ever written by the worker — writing the dragged axis back
    // fights the OS resize loop and makes the window pulse. At gesture end a
    // full two-axis snap settles the window on the largest ratio-correct box
    // under Chromium's 80%-of-display cap.

    let gesture = null; // { baseW, baseH, axis }
    let resizeEndTimer = null;
    let saveTimer = null;

    function snapMsg(extra) {
      return Object.assign(
        {
          t: "snap",
          innerW: pipWindow.innerWidth,
          innerH: pipWindow.innerHeight,
          ratio: currentVideoRatio(),
          screenW: pipWindow.screen.width,
          screenH: pipWindow.screen.height,
        },
        extra
      );
    }

    pipWindow.addEventListener("resize", () => {
      if (!settings.keepAspect) return;
      // Programmatic expand/restore fires resize events too; snapping on
      // their transitional sizes would fight the transition and strand the
      // window halfway. While expanded the window is in the fullscreen state
      // and must not be touched at all.
      if (expanded || Date.now() < (state.suppressSnapUntil || 0)) {
        clearTimeout(resizeEndTimer);
        gesture = null;
        state.lastSnapW = pipWindow.innerWidth;
        state.lastSnapH = pipWindow.innerHeight;
        return;
      }
      if (!gesture) {
        gesture = {
          baseW: state.lastSnapW ?? pipWindow.innerWidth,
          baseH: state.lastSnapH ?? pipWindow.innerHeight,
          axis: null,
        };
      }
      const dW = Math.abs(pipWindow.innerWidth - gesture.baseW);
      const dH = Math.abs(pipWindow.innerHeight - gesture.baseH);
      if (!gesture.axis && Math.max(dW, dH) >= 8) {
        gesture.axis = dW >= dH ? "width" : "height";
      }

      clearTimeout(resizeEndTimer);
      resizeEndTimer = setTimeout(() => {
        const axis = gesture?.axis || "width";
        gesture = null;
        state.lastSnapW = pipWindow.innerWidth;
        state.lastSnapH = pipWindow.innerHeight;
        post(snapMsg({ axis, end: true }));
      }, 350);

      if (gesture.axis) {
        post(snapMsg({ axis: gesture.axis }));
      }

      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          chrome.storage.local.set({ lastPipWidth: pipWindow.innerWidth });
        } catch {}
      }, 1000);
    });

    function currentVideoRatio() {
      return video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : state.ratio;
    }

    state.lastSnapW = pipWindow.innerWidth;
    state.lastSnapH = pipWindow.innerHeight;

    // If the source changes shape (rare), snap to the new ratio too.
    video.addEventListener("resize", () => {
      if (!settings.keepAspect) return;
      if (!video.videoWidth || !video.videoHeight) return;
      post(snapMsg({ axis: "width", end: true }));
    });

    // -------------------------------------------------------------- expand
    //
    // Real fullscreen is impossible here (document.fullscreenEnabled is false
    // in PiP documents) and programmatic bounds are area-capped at 25% of the
    // display. Flipping the window state to "fullscreen" is the one path that
    // reaches Chromium's actual PiP maximum (80% of the display per
    // dimension); "normal" brings the previous bounds back.

    let expanded = false;

    function refreshFsButton() {
      el.fullscreen.innerHTML = expanded ? ICONS.fsExit : ICONS.fsEnter;
      el.fullscreen.title = expanded ? "Restore size (F)" : "Expand (F)";
    }

    function toggleFullscreen() {
      state.suppressSnapUntil = Date.now() + 900;
      expanded = !expanded;
      post({ t: "expand", on: expanded });
      refreshFsButton();
    }

    el.fullscreen.addEventListener("click", toggleFullscreen);

    // ------------------------------------------------------------- keyboard

    pipWindow.addEventListener("keydown", (e) => {
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(video.volume + 0.05, false);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(video.volume - 0.05, video.muted);
          break;
        case "m":
        case "M":
          setVolume(video.volume, !video.muted);
          break;
        case "c":
        case "C":
          if (el.cc.classList.contains("present")) toggleCaptions();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "Escape":
          if (expanded) toggleFullscreen();
          break;
      }
    });

    // -------------------------------------------------------------- teardown

    function restore() {
      if (state.closed) return;
      state.closed = true;
      clearInterval(state.pingTimer);
      try {
        state.captions?.destroy();
      } catch {}
      for (const [ev, fn] of Object.entries(videoEvents)) video.removeEventListener(ev, fn);

      const ph = restoreInfo.placeholder;
      if (ph.parentNode) {
        ph.replaceWith(video);
      }
      if (restoreInfo.styleAttr == null) video.removeAttribute("style");
      else video.setAttribute("style", restoreInfo.styleAttr);
      video.controls = restoreInfo.controlsAttr;

      const wasPlaying = !video.paused && !video.ended;
      if (wasPlaying) {
        video.play().catch(() => {});
      }
      try {
        state.port?.disconnect();
      } catch {}
      if (active === state) active = null;
    }

    pipWindow.addEventListener("pagehide", restore);
  }
})();
