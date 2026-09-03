import React, { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFeatureFlag } from '../context/FeatureFlagContext';
import Spinner from '../components/ui/Spinner';
import ErrorBoundary from '../components/ui/ErrorBoundary';
import { FeatureGate } from '../components/support/FeatureGate';

/**
 * Per-route error boundary. Without this, a single page crash unmounts
 * the whole React tree and leaves a blank SPA. Phase 4 §4.5 outstanding
 * item — fixed in 2026-07-03.
 */
const RouteElement = ({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.ReactElement => (
  <ErrorBoundary level="section" sectionName={name}>
    {children}
  </ErrorBoundary>
);
import MainLayout from '../components/layout/MainLayout';
import AskAIButton from '../components/askai/AskAIButton';
import AccountRoute from './guards/AccountRoute';
import AdminRoute from './guards/AdminRoute';

// User pages
const AccountPage = lazy(() => import('../pages/AccountPage'));
const HomePage = lazy(() => import('../pages/HomePage'));
const FAQPage = lazy(() => import('../pages/FAQPage'));
const CommunityPage = lazy(() => import('../pages/CommunityPage'));
const SavedKnowledgePage = lazy(() => import('../pages/SavedKnowledgePage'));
const OfflinePage = lazy(() => import('../pages/OfflinePage'));
const SupportIndexPage = lazy(() => import('../pages/SupportIndexPage'));
const NewSupportRequestPage = lazy(() => import('../pages/NewSupportRequestPage'));
const SupportTicketPage = lazy(() => import('../pages/SupportTicketPage'));
const GoldenTicketPage = lazy(() => import('../pages/GoldenTicketPage'));
const GoldenTicketDetailPage = lazy(() => import('../pages/GoldenTicketDetailPage'));
const WelcomePackagePage = lazy(() => import('../pages/WelcomePackagePage'));
const ProgramPortalPage = lazy(() => import('../pages/ProgramPortalPage'));
const ProgramPage = lazy(() => import('../pages/ProgramPage'));
// v1.87 — Sign My Tee: designer wizard + share + public sign pages.
const TeeDesignerPage = lazy(() => import('../pages/TeeDesignerPage'));
const TeeSharePage = lazy(() => import('../pages/TeeSharePage'));
const TeeSignPage = lazy(() => import('../pages/TeeSignPage'));

// Admin pages
const AdminLogin = lazy(() => import('../admin/pages/AdminLogin'));
// S3-01 (CRITICAL) fix: lazy-load AdminLogin. Previously the
// /admin/login route was wired to <Navigate to="/admin" replace />,
// which redirected to /admin — wrapped in AdminRoute, which
// redirected non-admins back to /. The result: a logged-out
// admin could never log in via /admin/login. Now: render AdminLogin
// at /admin/login. AdminLogin itself handles the "already
// authenticated as admin" case (navigates to /admin).
const AdminDashboard = lazy(() => import('../admin/pages/AdminDashboard'));
const AdminFAQs = lazy(() => import('../admin/pages/AdminFAQs'));
const AdminUsers = lazy(() => import('../admin/pages/AdminUsers'));
const AdminSettings = lazy(() => import('../admin/pages/AdminSettings'));
const AdminCommunity = lazy(() => import('../admin/pages/AdminCommunity'));
const AdminModeration = lazy(() => import('../admin/pages/AdminModeration'));
const AdminUnresolvedSearch = lazy(() => import('../admin/pages/AdminUnresolvedSearch'));
// v1.83 — AdminZoomMeetings / AdminZoomInsights / AdminDocumentInsights /
// AdminContextSources are now embedded as named views inside the
// unified AdminKnowledge tab page. Their default exports remain so
// the lazy imports still type-check (and any stray direct imports
// keep working), but the corresponding top-level routes now
// `<Navigate>` to `/admin/knowledge?tab=...`.

const AdminKnowledge = lazy(() => import('../admin/pages/AdminKnowledge'));
const AdminAISettings = lazy(() => import('../admin/pages/AdminAISettings'));
const AdminApiLogsPage = lazy(() => import('../admin/pages/AdminApiLogsPage'));
const FaqReview = lazy(() => import('../admin/pages/FaqReview'));
const AdminAutoAnswerQueue = lazy(() => import('../admin/pages/AdminAutoAnswerQueue'));
const AdminFAQAudit = lazy(() => import('../admin/pages/AdminFAQAudit'));
const AdminBatches = lazy(() => import('../admin/pages/AdminBatches'));
const AdminProgramSettingsPage = lazy(() => import('../admin/pages/AdminProgramSettingsPage'));
const AdminDynamicCategoriesPage = lazy(() => import('../admin/pages/AdminDynamicCategoriesPage'));
const AdminCoursesPage = lazy(() => import('../admin/pages/AdminCoursesPage'));
const AdminProgramDashboard = lazy(() => import('../admin/pages/AdminProgramDashboard'));
const AdminProgramDetail = lazy(() => import('../admin/pages/AdminProgramDetail'));
const AdminSupportInbox = lazy(() => import('../admin/pages/AdminSupportInbox'));
const AdminSupportTicket = lazy(() => import('../admin/pages/AdminSupportTicket'));
const AdminSupportGuidance = lazy(() => import('../admin/pages/AdminSupportGuidance'));
const AdminSupportAnalytics = lazy(() => import('../admin/pages/AdminSupportAnalytics'));
const AdminSupportCategories = lazy(() => import('../admin/pages/AdminSupportCategories'));
const AdminGoldenTickets = lazy(() => import('../admin/pages/AdminGoldenTickets'));
const AdminGoldenLogs = lazy(() => import('../admin/pages/AdminGoldenLogs'));
const AdminFeatures = lazy(() => import('../admin/pages/AdminFeatures'));
const AdminSchedule = lazy(() => import('../admin/pages/AdminSchedule'));
const AdminWelcomePage = lazy(() => import('../admin/pages/AdminWelcomePage'));
const AdminZoomAssessmentsPage = lazy(() => import('../admin/pages/AdminZoomAssessmentsPage'));
const AdminZoomQuestionsPage = lazy(() => import('../admin/pages/AdminZoomQuestionsPage'));
const AdminProjectsPage = lazy(() => import('../admin/pages/AdminProjectsPage'));
const AdminTrain = lazy(() => import('../admin/pages/AdminTrain'));
const AdminSupportLayout = lazy(() => import('../admin/components/layout/AdminSupportLayout'));
const AdminLayout = lazy(() => import('../admin/components/layout/AdminLayout'));

function SupportRoute() {
  return <SupportIndexPage />;
}

function SupportNewRoute() {
  return <NewSupportRequestPage />;
}

function SupportTicketRoute() {
  return <SupportTicketPage />;
}

function GoldenRoute() {
  return (
    <FeatureGate featureKey="goldenTicket" featureLabel="Golden Ticket">
      <GoldenTicketPage />
    </FeatureGate>
  );
}

// v1.73 — dedicated user thread for a single Golden ticket. The
// in-app bell notification (from /admin/golden-tickets/:id/resolve
// + re-resolve + reject + ban) deep-links here so the user can
// actually read the admin answer — the generic /support/:id page
// does NOT render goldenResolutions[].
function GoldenTicketDetailRoute() {
  return (
    <FeatureGate featureKey="goldenTicket" featureLabel="Golden Ticket">
      <GoldenTicketDetailPage />
    </FeatureGate>
  );
}

export default function AppRoutes() {
  const { loading } = useAuth();
  const location = useLocation();
  const { enabled: askAiEnabled } = useFeatureFlag('askAiChatbot');
  const [mounted, setMounted] = useState(false);

  // Prevent flash: only render routes after first auth resolution
  useEffect(() => {
    setMounted(true);
  }, []);

  if (loading || !mounted) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }

  // Chatbot visibility is admin-controlled via the `askAiChatbot` feature
  // flag (/admin/features). Never shown on admin pages. `askAiEnabled` is
  // undefined while flags load and null for an unknown key — both treated
  // as off so the button never flashes in.
  const showAskAI = askAiEnabled === true && !location.pathname.startsWith('/admin');

  return (
    <>
      <Suspense fallback={<div className="min-h-screen bg-bg flex items-center justify-center"><Spinner size="md" /></div>}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<RouteElement name="root"><HomePage /></RouteElement>} />
            <Route path="/programs" element={<RouteElement name="programs"><ProgramPortalPage /></RouteElement>} />
            <Route path="/explore/select" element={<RouteElement name="explore-select"><Navigate to="/programs" replace /></RouteElement>} />
            <Route path="/faq" element={<RouteElement name="faq"><FAQPage /></RouteElement>} />
            <Route path="/faq/:id" element={<RouteElement name="faq-:id"><FAQPage /></RouteElement>} />
            <Route path="/community" element={<RouteElement name="community"><CommunityPage /></RouteElement>} />
            <Route path="/saved" element={<RouteElement name="saved"><SavedKnowledgePage /></RouteElement>} />
            <Route path="/offline" element={<RouteElement name="offline"><FeatureGate featureKey="offlineMode" featureLabel="Offline Mode"><OfflinePage /></FeatureGate></RouteElement>} />
            <Route path="/support" element={<RouteElement name="support"><SupportRoute /></RouteElement>} />
            <Route path="/support/new" element={<RouteElement name="support-new"><SupportNewRoute /></RouteElement>} />
            <Route path="/support/:id" element={<RouteElement name="support-:id"><SupportTicketRoute /></RouteElement>} />
            <Route path="/golden" element={<RouteElement name="golden"><GoldenRoute /></RouteElement>} />
            <Route path="/golden/ticket/:id" element={<RouteElement name="golden-ticket-:id"><GoldenTicketDetailRoute /></RouteElement>} />
            <Route path="/program/:slug" element={<RouteElement name="program-:slug"><ProgramPage /></RouteElement>} />
            <Route
              path="/account"
              element={<RouteElement name="account"><AccountRoute>
                  <AccountPage />
                </AccountRoute></RouteElement>}
            />
            <Route
              path="/welcome"
              element={<RouteElement name="welcome"><AccountRoute>
                  <FeatureGate featureKey="welcomePackage" featureLabel="Welcome Package">
                    <WelcomePackagePage />
                  </FeatureGate>
                </AccountRoute></RouteElement>}
            />
            {/* v1.87 — Sign My Tee. The wizard + share page are auth-protected
                (they're the owner's surface). The sign-page is public so a
                non-logged-in visitor can also sign via a typed signerName. */}
            <Route
              path="/tee"
              element={<RouteElement name="tee"><AccountRoute>
                  <TeeDesignerPage />
                </AccountRoute></RouteElement>}
            />
            <Route
              path="/tee/share/:shareId"
              element={<RouteElement name="tee-share-:shareId"><TeeSharePage /></RouteElement>}
            />
            <Route
              path="/tee/sign/:shareId"
              element={<RouteElement name="tee-sign-:shareId"><TeeSignPage /></RouteElement>}
            />
            </Route>

          <Route
            path="/admin/login"
            element={<RouteElement name="admin-login"><AdminLogin /></RouteElement>}
          />
          <Route path="/admin" element={<RouteElement name="admin"><AdminRoute><AdminLayout><AdminDashboard /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/faqs" element={<RouteElement name="admin-faqs"><AdminRoute><AdminLayout><AdminFAQs /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/users" element={<RouteElement name="admin-users"><AdminRoute><AdminLayout><AdminUsers /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/settings" element={<RouteElement name="admin-settings"><AdminRoute><AdminLayout><AdminSettings /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/community" element={<RouteElement name="admin-community"><AdminRoute><AdminLayout><AdminCommunity /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/moderation" element={<RouteElement name="admin-moderation"><AdminRoute><AdminLayout><AdminModeration /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/unresolved-search" element={<RouteElement name="admin-unresolved-search"><AdminRoute><AdminLayout><AdminUnresolvedSearch /></AdminLayout></AdminRoute></RouteElement>} />
           <Route path="/admin/zoom-meetings" element={<RouteElement name="admin-zoom-meetings"><AdminRoute><AdminLayout><Navigate to="/admin/knowledge?tab=zoom" replace /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/zoom-insights" element={<RouteElement name="admin-zoom-insights"><AdminRoute><AdminLayout><Navigate to="/admin/knowledge?tab=zoom-insights" replace /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/document-insights" element={<RouteElement name="admin-document-insights"><AdminRoute><AdminLayout><FeatureGate featureKey="documentPipeline" featureLabel="Document Pipeline"><Navigate to="/admin/knowledge?tab=doc-insights" replace /></FeatureGate></AdminLayout></AdminRoute></RouteElement>} />
          {/* Unified knowledge page (v1.83) — single entry point for
            * Context Sources + Zoom Meetings + Zoom + Document Insights.
            * Old routes still resolve here via <Navigate> redirects below. */}
          <Route path="/admin/knowledge" element={<RouteElement name="admin-knowledge"><AdminRoute><AdminLayout><AdminKnowledge /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/settings/ai" element={<RouteElement name="admin-settings-ai"><AdminRoute><AdminLayout><AdminAISettings /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/ai-logs" element={<RouteElement name="admin-ai-logs"><AdminRoute><AdminLayout><AdminApiLogsPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/faqs/review" element={<RouteElement name="admin-faqs-review"><AdminRoute><AdminLayout><FeatureGate featureKey="faqFreshness" featureLabel="FAQ Freshness Review"><FaqReview /></FeatureGate></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/welcome" element={<RouteElement name="admin-welcome"><AdminRoute><AdminLayout><AdminWelcomePage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/zoom" element={<RouteElement name="admin-zoom"><AdminRoute><AdminLayout><AdminZoomAssessmentsPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/zoom/questions" element={<RouteElement name="admin-zoom-questions"><AdminRoute><AdminLayout><AdminZoomQuestionsPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/projects" element={<RouteElement name="admin-projects"><AdminRoute><AdminLayout><AdminProjectsPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/context-sources" element={<RouteElement name="admin-context-sources"><AdminRoute><AdminLayout><Navigate to="/admin/knowledge?tab=upload" replace /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/train" element={<RouteElement name="admin-train"><AdminRoute><AdminLayout><AdminTrain /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/auto-answer" element={<RouteElement name="admin-auto-answer"><AdminRoute><AdminLayout><FeatureGate featureKey="aiAutoAnswer" featureLabel="AI Auto-Answer"><AdminAutoAnswerQueue /></FeatureGate></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/faq-audit" element={<RouteElement name="admin-faq-audit"><AdminRoute><AdminLayout><FeatureGate featureKey="faqFreshness" featureLabel="FAQ Freshness Audit"><AdminFAQAudit /></FeatureGate></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/batches" element={<RouteElement name="admin-batches"><AdminRoute><AdminLayout><AdminBatches /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/courses" element={<RouteElement name="admin-courses"><AdminRoute><AdminLayout><AdminCoursesPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/programs/:id/settings" element={<RouteElement name="admin-programs-:id-settings"><AdminRoute><AdminLayout><AdminProgramSettingsPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/programs/:id/categories" element={<RouteElement name="admin-programs-:id-categories"><AdminRoute><AdminLayout><AdminDynamicCategoriesPage /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/programs" element={<RouteElement name="admin-programs"><AdminRoute><AdminLayout><AdminProgramDashboard /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/programs/:id" element={<RouteElement name="admin-programs-:id"><AdminRoute><AdminLayout><AdminProgramDetail /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/support" element={<RouteElement name="admin-support"><AdminRoute><AdminLayout><FeatureGate featureKey="sessionSupport" featureLabel="Support Dashboard"><AdminSupportLayout /></FeatureGate></AdminLayout></AdminRoute></RouteElement>}>
            <Route index element={<AdminSupportInbox />} />
            <Route path="analytics" element={<RouteElement name="analytics"><AdminSupportAnalytics /></RouteElement>} />
            <Route path="guidance" element={<RouteElement name="guidance"><AdminSupportGuidance /></RouteElement>} />
            <Route path="categories" element={<RouteElement name="categories"><AdminSupportCategories /></RouteElement>} />
            <Route path=":id" element={<RouteElement name=":id"><AdminSupportTicket /></RouteElement>} />
          </Route>
          <Route path="/admin/golden-tickets" element={<RouteElement name="admin-golden-tickets"><AdminRoute><AdminLayout><FeatureGate featureKey="goldenTicket" featureLabel="Golden Tickets"><AdminSupportLayout /></FeatureGate></AdminLayout></AdminRoute></RouteElement>}>
            <Route index element={<AdminGoldenTickets />} />
          </Route>
          {/* v1.73 — The AdminGoldenLogs page has been sitting
              built-but-unwired since v1.71. Wrap it in the same
              AdminSupportLayout so the "Golden Queue / Golden Logs"
              tab bar at the top lights up correctly. Falls under
              the goldenTicket feature flag like its sibling. */}
          <Route path="/admin/golden-logs" element={<RouteElement name="admin-golden-logs"><AdminRoute><AdminLayout><FeatureGate featureKey="goldenTicket" featureLabel="Golden Logs"><AdminSupportLayout /></FeatureGate></AdminLayout></AdminRoute></RouteElement>}>
            <Route index element={<AdminGoldenLogs />} />
          </Route>
          <Route path="/admin/features" element={<RouteElement name="admin-features"><AdminRoute><AdminLayout><AdminFeatures /></AdminLayout></AdminRoute></RouteElement>} />
          <Route path="/admin/schedule" element={<RouteElement name="admin-schedule"><AdminRoute><AdminLayout><AdminSchedule /></AdminLayout></AdminRoute></RouteElement>} />

          <Route path="*" element={<RouteElement name="*"><Navigate to="/" state={{ from: location.pathname }} /></RouteElement>} />
        </Routes>
      </Suspense>
      {showAskAI && <AskAIButton />}
    </>
  );
}
