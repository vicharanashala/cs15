// Offline Mode (PWA) — service worker registration, gated by the
// `offlineMode` feature flag.
//
// vite-plugin-pwa is configured with `injectRegister: false` (see
// vite.config.ts), so nothing registers automatically on page load.
// This module is the *only* place the service worker gets registered
// or unregistered, and it's only called from useOfflineMode() once the
// flag's real value is known — so when the flag is off, no service
// worker exists at all, not even a dormant one.
//
// `virtual:pwa-register` is a module vite-plugin-pwa generates at build
// (and dev) time — it doesn't exist as a real file, which is why it
// needs the `vite-plugin-pwa/client` type reference in vite-env.d.ts.

let currentRegistration: ServiceWorkerRegistration | undefined;
let enabling = false;

/** Registers the offline service worker. Safe to call multiple times —
 *  no-ops if already registered or a registration is already in flight. */
export async function enableOfflineMode(): Promise<void> {
  if (currentRegistration || enabling) return;
  if (!('serviceWorker' in navigator)) {
    // Old/unsupported browser — nothing we can do, fail quietly rather
    // than throwing and breaking the rest of the app.
    console.warn('[offlineMode] Service workers are not supported in this browser.');
    return;
  }
  enabling = true;
  try {
    const { registerSW } = await import('virtual:pwa-register');
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        currentRegistration = registration;
      },
      onRegisterError(error) {
        console.error('[offlineMode] Service worker registration failed:', error);
      },
    });
  } finally {
    enabling = false;
  }
}

/** Unregisters the offline service worker and clears its caches. Called
 *  when the flag is off (or gets toggled off at runtime by an admin). */
export async function disableOfflineMode(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const registrations = currentRegistration
    ? [currentRegistration]
    : await navigator.serviceWorker.getRegistrations();

  await Promise.all(registrations.map((reg) => reg.unregister()));
  currentRegistration = undefined;

  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.includes('faq-api-cache') || key.startsWith('workbox-')).map((key) => caches.delete(key))
    );
  }
}

/** True once a service worker registration is active in this tab. */
export function isOfflineModeRegistered(): boolean {
  return currentRegistration !== undefined;
}
