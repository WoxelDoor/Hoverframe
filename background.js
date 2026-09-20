// Hoverframe service worker.
//
// The Document Picture-in-Picture window cannot move itself (moveTo/moveBy are
// disabled by spec) and cannot resize itself without a user gesture. But it is
// a regular browser window as far as the extensions API is concerned, so this
// worker moves and resizes it with chrome.windows.update on behalf of the
// content script. That is what makes drag-from-anywhere and live aspect-ratio
// snapping possible at all.
//
// MV3 workers die after ~30 s idle and take every Port down with them, so the
// protocol is stateless: each (re)connection starts with "opening"+"opened"
// or "hello", either of which lets the worker resolve the PiP windowId from
// scratch. The content script caches the windowId and hands it back on
// reconnect; nothing here survives between lives except what the content
// script re-sends.

// Window id captured from windows.onCreated while a session is opening.
let expectingWindow = null; // { resolve, timer }

chrome.windows.onCreated.addListener((win) => {
  if (expectingWindow) {
    expectingWindow.resolve(win.id);
  }
});

function armWindowCapture() {
  disarmWindowCapture();
  return new Promise((res) => {
    expectingWindow = {
      resolve: res,
      timer: setTimeout(() => {
        res(null);
        disarmWindowCapture();
      }, 5000),
    };
  });
}

function disarmWindowCapture() {
  if (expectingWindow) {
    clearTimeout(expectingWindow.timer);
    expectingWindow = null;
  }
}

// Fallback identification: find the window whose bounds best match what the
// PiP document reports about itself.
async function findWindowByBounds(info, excludeWindowId) {
  const wins = await chrome.windows.getAll();
  let best = null;
  let bestScore = Infinity;
  for (const w of wins) {
    if (w.id === excludeWindowId) continue;
    const score =
      Math.abs(w.left - info.screenX) +
      Math.abs(w.top - info.screenY) +
      Math.abs(w.width - info.outerW) +
      Math.abs(w.height - info.outerH);
    if (score < bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return bestScore < 160 && best ? best.id : null;
}

// One windows.update in flight per session; the latest requested bounds win.
// Moves and resizes go through the same gate so they cannot reorder.
function queueBounds(s, bounds) {
  s.pending = Object.assign(s.pending || {}, bounds);
  if (s.updating) return;
  s.updating = true;
  (async () => {
    while (s.pending) {
      const b = s.pending;
      s.pending = null;
      try {
        await chrome.windows.update(s.windowId, b);
      } catch {
        s.pending = null;
        break;
      }
    }
    s.updating = false;
  })();
}

// Resize the PiP window so its inner (content) area matches the video aspect
// ratio.
//
// During a live gesture (msg.end falsy) only the FOLLOWER dimension is ever
// written: the axis the user is dragging belongs to the OS resize loop, and
// echoing a slightly stale value back into it makes the window pulse. The
// driven axis is decided by the content script once per gesture (msg.axis).
//
// Chromium clamps programmatic bounds changes of a PiP window to 25% of the
// display AREA (kMaxSiteRequestedWindowSizeRatio) and crushes both dimensions
// when the request exceeds it. Manual user resizes are allowed up to 80% per
// dimension. So: never issue an update whose outer area would cross the 25%
// cap — a window the user made bigger than that is left alone (letterboxing
// beats yanking it smaller), and "expand" goes through the window state
// instead of bounds.
const MAX_AREA_RATIO = 0.24; // just under Chromium's 0.25 to avoid the clamp

async function snapToRatio(s, msg) {
  const { innerW, innerH, ratio, axis, end } = msg;
  if (!s || s.windowId == null || !ratio) return;
  let win;
  try {
    win = await chrome.windows.get(s.windowId);
  } catch {
    return;
  }
  if (win.state !== "normal") return;
  const overheadW = Math.max(0, win.width - innerW);
  const overheadH = Math.max(0, win.height - innerH);
  const maxOuterArea =
    msg.screenW && msg.screenH ? msg.screenW * msg.screenH * MAX_AREA_RATIO : Infinity;
  const minInnerW = 160;
  const minInnerH = Math.max(90, Math.round(160 / ratio));

  const drivingWidth = axis !== "height";

  let targetW;
  let targetH;
  if (end || drivingWidth) {
    targetW = drivingWidth ? innerW : Math.round(innerH * ratio);
    targetH = drivingWidth ? Math.round(innerW / ratio) : innerH;
  }

  if (end) {
    targetW = Math.max(minInnerW, targetW);
    targetH = Math.max(minInnerH, targetH);
    if (targetW === innerW && targetH === innerH) return;
    if ((targetW + overheadW) * (targetH + overheadH) > maxOuterArea) return;
    queueBounds(s, {
      width: targetW + overheadW,
      height: targetH + overheadH,
    });
    return;
  }

  if (drivingWidth) {
    targetH = Math.max(minInnerH, targetH);
    if (targetH === innerH) return;
    if ((win.width) * (targetH + overheadH) > maxOuterArea) return;
    queueBounds(s, { height: targetH + overheadH });
  } else {
    targetW = Math.max(minInnerW, Math.round(innerH * ratio));
    if (targetW === innerW) return;
    if ((targetW + overheadW) * (win.height) > maxOuterArea) return;
    queueBounds(s, { width: targetW + overheadW });
  }
}

async function resolveWindowId(s, msg) {
  // 1. A windowId the content script cached from a previous life.
  if (msg.windowId != null) {
    try {
      await chrome.windows.get(msg.windowId);
      return msg.windowId;
    } catch {}
  }
  // 2. The window captured by onCreated during "opening".
  if (s.capture) {
    const captured = await s.capture;
    disarmWindowCapture();
    if (captured != null && captured !== s.tabWindowId) return captured;
  }
  // 3. Bounds matching.
  return findWindowByBounds(msg, s.tabWindowId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hoverframe") return;

  const s = {
    port,
    tabId: port.sender?.tab?.id ?? null,
    tabWindowId: port.sender?.tab?.windowId ?? null,
    windowId: null,
    binding: null,
    pending: null,
    updating: false,
    capture: null,
  };

  port.onMessage.addListener(async (msg) => {
    switch (msg.t) {
      case "opening":
        s.capture = armWindowCapture();
        break;

      case "opened": // first bind after requestWindow
      case "hello": { // re-bind after a worker restart
        s.binding = resolveWindowId(s, msg);
        s.windowId = await s.binding;
        try {
          port.postMessage({ t: "bound", windowId: s.windowId });
        } catch {}
        if (s.windowId != null && msg.ratio && msg.t === "opened") {
          snapToRatio(s, { ...msg, axis: "width", end: true });
        }
        break;
      }

      case "dragStart":
        // Authoritative window position for the gesture: the renderer's
        // window.screenX can be stale right after programmatic moves.
        if (s.binding) await s.binding;
        if (s.windowId != null) {
          try {
            const win = await chrome.windows.get(s.windowId);
            port.postMessage({ t: "dragBase", left: win.left, top: win.top });
          } catch {}
        }
        break;

      case "move":
        if (s.windowId != null) {
          queueBounds(s, { left: Math.round(msg.left), top: Math.round(msg.top) });
        }
        break;

      case "snap":
        await snapToRatio(s, msg);
        break;

      case "ping": // keepalive: the message itself resets the idle timer
        break;

      case "expand":
        // Bounds updates are area-capped at 25% of the display, but flipping
        // the window state to fullscreen grows it to Chromium's real maximum
        // (80% per dimension) and "normal" restores the previous bounds.
        if (s.windowId != null) {
          try {
            await chrome.windows.update(s.windowId, {
              state: msg.on ? "fullscreen" : "normal",
            });
          } catch {}
        }
        break;

      case "backToTab":
        if (s.tabId != null) {
          try {
            await chrome.tabs.update(s.tabId, { active: true });
            if (s.tabWindowId != null) {
              await chrome.windows.update(s.tabWindowId, { focused: true });
            }
          } catch {}
        }
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    disarmWindowCapture();
  });
});

// Toolbar button / Alt+P: ask every frame in the tab for its best video, then
// tell the winning frame to open PiP. Frames answer via one-off messages so we
// can address the winner by frameId without the webNavigation permission.
const pendingPicks = new Map(); // tabId -> { candidates, timer }

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const pick = { candidates: [], timer: null };
  pendingPicks.set(tab.id, pick);
  pick.timer = setTimeout(() => {
    pendingPicks.delete(tab.id);
    if (pick.candidates.length === 0) return;
    pick.candidates.sort((a, b) => b.score - a.score);
    const winner = pick.candidates[0];
    chrome.tabs
      .sendMessage(tab.id, { type: "hoverframe-open-best" }, { frameId: winner.frameId })
      .catch(() => {});
  }, 250);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "hoverframe-report" });
  } catch {
    clearTimeout(pick.timer);
    pendingPicks.delete(tab.id);
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "hoverframe-candidate" && sender.tab) {
    const pick = pendingPicks.get(sender.tab.id);
    if (pick) {
      pick.candidates.push({ frameId: sender.frameId ?? 0, score: msg.score });
    }
  }
});
