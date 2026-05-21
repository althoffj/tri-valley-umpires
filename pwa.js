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
