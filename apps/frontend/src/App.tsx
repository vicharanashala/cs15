import React, { Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { BatchProvider } from './context/BatchContext';
import { FeatureFlagProvider } from './context/FeatureFlagContext';
import AuthModalHost from './components/auth/AuthModalHost';
import AppRoutes from './routes/AppRoutes';
import Spinner from './components/ui/Spinner';
import ErrorBoundary from './components/ui/ErrorBoundary';
// v1.87 — Sign My Tee: tree-level gate that mandates every
// Summership-era user enters their Internship End Date before
// using the app. Mounts inside AuthProvider (needs `useAuth`) and
// outside AppRoutes (needs to overlay every page uniformly).
import InternshipEndDateGate from './context/InternshipEndDateGate';
// Offline Mode (PWA) — headless manager that (un)registers the service
// worker based on the `offlineMode` feature flag. Renders nothing.
import OfflineModeManager from './offline/OfflineModeManager';

export default function App() {
  return (
    <BrowserRouter basename="/csfaq">
      <AuthProvider>
        <BatchProvider>
          <FeatureFlagProvider>
            <OfflineModeManager />
            <AuthModalHost>
              <Suspense fallback={<div className="min-h-screen bg-bg flex items-center justify-center"><Spinner size="md" /></div>}>
                <ErrorBoundary sectionName="App (top-level)">
                  <InternshipEndDateGate>
                    <AppRoutes />
                  </InternshipEndDateGate>
                </ErrorBoundary>
              </Suspense>
            </AuthModalHost>
          </FeatureFlagProvider>
        </BatchProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
