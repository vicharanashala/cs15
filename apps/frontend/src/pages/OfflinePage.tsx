import React, { useEffect, useState } from 'react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { isOfflineModeRegistered } from '../offline/registerOfflineServiceWorker';

// Fired by the browser before it would normally show its own "install
// this site" prompt. We intercept it so we can trigger install from our
// own button instead, and hide the browser's default mini-infobar.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function OfflinePage(): React.ReactElement {
  const [swActive, setSwActive] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [cachedCount, setCachedCount] = useState<number | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // The service worker registers asynchronously on app load, so poll
    // briefly rather than assuming it's ready on first render.
    const check = () => setSwActive(isOfflineModeRegistered());
    check();
    const interval = setInterval(check, 1000);

    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    const onInstalled = () => setInstalled(true);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      clearInterval(interval);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!swActive || !('caches' in window)) return;
    caches.open('faq-api-cache').then((cache) =>
      cache.keys().then((keys) => setCachedCount(keys.length))
    );
  }, [swActive]);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-bold text-ink">Offline Mode</h1>
        <p className="text-ink-soft mt-2">
          FAQs you've already viewed stay available even without a connection.
        </p>
      </div>

      <Card variant="elevated" className="p-6 space-y-4">
        <StatusRow
          label="Connection"
          value={isOnline ? 'Online' : 'Offline'}
          ok={isOnline}
        />
        <StatusRow
          label="Offline caching"
          value={swActive ? 'Active' : 'Starting up…'}
          ok={swActive}
        />
        {swActive && (
          <StatusRow
            label="FAQ pages cached"
            value={cachedCount === null ? '—' : String(cachedCount)}
            ok={cachedCount !== null && cachedCount > 0}
          />
        )}
      </Card>

      <Card variant="default" className="p-6">
        <h2 className="font-semibold text-ink mb-1">How it works</h2>
        <p className="text-sm text-ink-soft leading-relaxed">
          Every FAQ list and FAQ detail page you visit is saved automatically in the
          background. If your connection drops later, those same pages will still
          load — no extra steps needed. Pages you haven't visited yet still require a
          connection the first time.
        </p>
      </Card>

      {!installed && (
        <Card variant="default" className="p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-ink mb-1">Install the app</h2>
            <p className="text-sm text-ink-soft">
              Add Yaksha FAQ to your home screen for quicker access.
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={handleInstall}
            disabled={!installPrompt}
            title={installPrompt ? undefined : 'Your browser will show an install option when available'}
          >
            Install
          </Button>
        </Card>
      )}
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="flex items-center gap-2 text-sm font-medium text-ink">
        <span className={`w-2 h-2 rounded-full ${ok ? 'bg-success' : 'bg-warning'}`} />
        {value}
      </span>
    </div>
  );
}
