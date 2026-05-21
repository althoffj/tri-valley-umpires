// pwa.js — service worker registration, install prompt, and stale-page refresh
let deferredPrompt = null;

export function isPWAMode() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

export function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function canInstall() {
  if (isPWAMode()) return false;
  if (!isMobileDevice()) return false;
  return deferredPrompt !== null || isIOS();
}

export async function triggerInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === "accepted";
}

// ── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

      reg.addEventListener("updatefound", () => {
        const newSW = reg.installing;
        newSW.addEventListener("statechange", () => {
          if (newSW.state === "installed" && navigator.serviceWorker.controller) {
            navigator.serviceWorker.addEventListener("controllerchange", () => {
              window.location.reload();
            }, { once: true });
          }
        });
      });

      // Also handle the SW_ACTIVATED message (sent by the SW on activate).
      navigator.serviceWorker.addEventListener("message", event => {
        if (event.data?.type === "SW_ACTIVATED") {
          window.location.reload();
        }
      });

    } catch (_) {
      // SW registration failure is non-fatal.
    }
  });
}

// ── Stale-page reload (mobile PWA) ────────────────────────────────────────────
// On mobile, the OS can suspend the PWA for hours. When the user reopens it,
// the page is still "alive" but Firestore listeners may have dropped and
// the UI can be hours out of date. Reload if backgrounded for > 10 minutes.
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
let _hiddenAt = null;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    _hiddenAt = Date.now();
  } else if (document.visibilityState === "visible" && _hiddenAt !== null) {
    if (Date.now() - _hiddenAt > STALE_THRESHOLD_MS) {
      window.location.reload();
    }
    _hiddenAt = null;
  }
});

// ── Swipe-down to dismiss modals ─────────────────────────────────────────────
// Works on any position:fixed full-screen overlay whose id ends in "Modal",
// and on dynamically-created overlays that set data-modal="remove".
// Only triggers when the inner sheet is scrolled to the top.
const SD_THRESHOLD = 80; // px of downward drag to commit a dismiss
let _sdOverlay = null;
let _sdSheet   = null;
let _sdStartY  = null;
let _sdDy      = 0;

document.addEventListener("touchstart", e => {
  // Find nearest qualifying modal overlay
  const overlay = e.target.closest('[id$="Modal"], [data-modal]');
  if (!overlay) return;
  // [id$="Modal"] elements hide via inline style.display; [data-modal] elements
  // are appended when shown and removed when dismissed, so never hidden.
  if (overlay.style.display === "none") return;

  const sheet = overlay.firstElementChild;
  if (!sheet || !sheet.contains(e.target)) return; // touching backdrop, not sheet
  if (sheet.scrollTop > 0) return;                 // sheet is mid-scroll — let scroll win

  _sdOverlay = overlay;
  _sdSheet   = sheet;
  _sdStartY  = e.touches[0].clientY;
  _sdDy      = 0;
  sheet.style.transition = "none";
}, { passive: true });

document.addEventListener("touchmove", e => {
  if (!_sdSheet) return;
  const dy = e.touches[0].clientY - _sdStartY;
  if (dy <= 0) {
    // Moved up — cancel gesture, let normal scroll take over
    _sdSheet.style.transform  = "";
    _sdSheet.style.transition = "";
    _sdSheet = _sdOverlay = null;
    return;
  }
  _sdDy = dy;
  _sdSheet.style.transform = `translateY(${dy}px)`;
}, { passive: true });

document.addEventListener("touchend", () => {
  if (!_sdSheet) return;
  const sheet   = _sdSheet;
  const overlay = _sdOverlay;
  const dy      = _sdDy;
  _sdSheet = _sdOverlay = null;
  _sdStartY = null;

  if (dy >= SD_THRESHOLD) {
    // Animate the sheet off-screen then close
    sheet.style.transition = "transform 0.22s ease-in";
    sheet.style.transform  = "translateY(110%)";
    setTimeout(() => {
      sheet.style.transform  = "";
      sheet.style.transition = "";
      if (overlay.dataset.modal === "remove") {
        overlay.remove();
      } else {
        overlay.style.display = "none";
        // Dispatch a synthetic close event so page JS can do cleanup
        overlay.dispatchEvent(new CustomEvent("swipe-dismissed", { bubbles: true }));
      }
    }, 220);
  } else {
    // Spring back with a slight overshoot so it feels alive
    sheet.style.transition = "transform 0.3s cubic-bezier(0.34,1.56,0.64,1)";
    sheet.style.transform  = "translateY(0)";
    setTimeout(() => { sheet.style.transform = ""; sheet.style.transition = ""; }, 320);
  }
});

document.addEventListener("touchcancel", () => {
  if (_sdSheet) {
    _sdSheet.style.transform  = "";
    _sdSheet.style.transition = "";
    _sdSheet = _sdOverlay = null;
  }
}, { passive: true });

// ── Left-edge swipe to go back ────────────────────────────────────────────────
// iOS PWA has no browser back button — edge swipe restores that muscle memory.
const BACK_EDGE   = 28;  // px from left edge that counts as an edge-swipe start
const BACK_THRESH = 80;  // px horizontal travel needed to trigger history.back()
let _backStartX = null;
let _backStartY = null;
let _backEl     = null;

document.addEventListener("touchstart", e => {
  const touch = e.touches[0];
  if (touch.clientX > BACK_EDGE) return;
  if (window.history.length <= 1) return; // nothing to go back to
  _backStartX = touch.clientX;
  _backStartY = touch.clientY;
  // Visual edge indicator
  _backEl = document.createElement("div");
  _backEl.style.cssText = [
    "position:fixed", "left:0", "top:50%", "transform:translateY(-50%)",
    "width:4px", "height:56px",
    "background:var(--accent,#601929)",
    "border-radius:0 6px 6px 0",
    "z-index:99999", "opacity:0",
    "transition:opacity 0.08s,width 0.08s",
    "pointer-events:none"
  ].join(";");
  document.body.appendChild(_backEl);
}, { passive: true });

document.addEventListener("touchmove", e => {
  if (_backStartX === null) return;
  const touch = e.touches[0];
  const dx    = touch.clientX - _backStartX;
  const dy    = Math.abs(touch.clientY - _backStartY);
  // Cancel if gesture is more vertical than horizontal
  if (dy > dx * 1.2 && dx < 20) { _cleanBackEl(); return; }
  if (dx > 0 && _backEl) {
    const progress = Math.min(dx / BACK_THRESH, 1);
    _backEl.style.opacity = String(progress * 0.9);
    _backEl.style.width   = (4 + progress * 24) + "px";
  }
}, { passive: true });

document.addEventListener("touchend", e => {
  if (_backStartX === null) return;
  const dx = e.changedTouches[0].clientX - _backStartX;
  _cleanBackEl();
  if (dx >= BACK_THRESH) history.back();
});

document.addEventListener("touchcancel", _cleanBackEl, { passive: true });

function _cleanBackEl() {
  if (_backEl) { _backEl.remove(); _backEl = null; }
  _backStartX = _backStartY = null;
}

// ── Pull-to-refresh (PWA standalone only) ────────────────────────────────────
// Browsers have native pull-to-refresh; we only add our own in standalone PWA
// mode where there's no browser chrome to provide it.
const PTR_THRESHOLD = 72; // px of pull needed to trigger a refresh
let _ptrStartY  = null;
let _ptrDy      = 0;
let _ptrEl      = null;

function _getPtrEl() {
  if (_ptrEl) return _ptrEl;
  _ptrEl = document.createElement("div");
  _ptrEl.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "height:0",
    "overflow:hidden", "display:flex", "align-items:flex-end",
    "justify-content:center", "padding-bottom:10px",
    "background:var(--container,#1a1a2e)",
    "color:var(--light-text,#aaa)", "font-size:0.88rem",
    "z-index:99999", "pointer-events:none", "box-sizing:border-box",
    "transition:height 0.08s ease-out"
  ].join(";");
  document.body.prepend(_ptrEl);
  return _ptrEl;
}

document.addEventListener("touchstart", e => {
  if (!isPWAMode()) return;
  if (window.scrollY === 0) {
    _ptrStartY = e.touches[0].clientY;
    _ptrDy = 0;
  }
}, { passive: true });

document.addEventListener("touchmove", e => {
  if (_ptrStartY === null) return;
  _ptrDy = e.touches[0].clientY - _ptrStartY;
  if (_ptrDy <= 0) {
    _ptrStartY = null;
    if (_ptrEl) _ptrEl.style.height = "0";
    return;
  }
  // Dampen the pull so it feels resistive (like native iOS)
  const h   = Math.min(_ptrDy * 0.45, 58);
  const el  = _getPtrEl();
  el.style.height    = h + "px";
  el.textContent     = _ptrDy >= PTR_THRESHOLD ? "↻  Release to refresh" : "↓  Pull to refresh";
  el.style.color     = _ptrDy >= PTR_THRESHOLD ? "#b8f2c4" : "var(--light-text,#aaa)";
}, { passive: true });

document.addEventListener("touchend", () => {
  if (_ptrStartY === null) return;
  const triggered = _ptrDy >= PTR_THRESHOLD;
  _ptrStartY = null;
  if (_ptrEl) {
    _ptrEl.style.transition = "height 0.2s ease-out";
    _ptrEl.style.height = "0";
  }
  if (triggered) {
    // Brief pause so the user sees the indicator snap back before reload
    setTimeout(() => window.location.reload(), 250);
  }
});

document.addEventListener("touchcancel", () => {
  _ptrStartY = null;
  if (_ptrEl) _ptrEl.style.height = "0";
}, { passive: true });

// ── Install prompt handling ───────────────────────────────────────────────────
// Capture Android/Chrome install prompt before the browser shows it.
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  window.dispatchEvent(new CustomEvent("pwa-install-available"));
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  window.dispatchEvent(new CustomEvent("pwa-installed"));
});
