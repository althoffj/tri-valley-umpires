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

      // When a new SW is found, wait for it to finish installing, then reload.
      reg.addEventListener("updatefound", () => {
        const newSW = reg.installing;
        newSW.addEventListener("statechange", () => {
          // "installed" + existing controller = update is ready, old SW still running.
          if (newSW.state === "installed" && navigator.serviceWorker.controller) {
            // The new SW called skipWaiting(), so it will activate shortly.
            // Reload once it does to pick up fresh assets.
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
