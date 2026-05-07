// pwa.js — service worker registration and install prompt handling
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

// Register the combined FCM + app shell service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => {});
  });
}

// Capture Android/Chrome install prompt before browser shows it
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  window.dispatchEvent(new CustomEvent("pwa-install-available"));
});

// After install succeeds, clear prompt and notify
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  window.dispatchEvent(new CustomEvent("pwa-installed"));
});
