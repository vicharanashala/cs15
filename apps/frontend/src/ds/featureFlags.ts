// MANUAL SYNC REQUIRED: this file mirrors
// apps/backend/src/services/featureFlags.ts in the backend. Both must
// stay byte-identical for the FEATURE_FLAGS object literal (default
// values, labels, descriptions, categories). A future R2 task should
// move both to a shared @csflare/feature-flags package generated from
// a single source of truth.

export type FeatureFlagCategory =
  | 'community'
  | 'support'
  | 'integrations'
  | 'faq'
  | 'onboarding'
  | 'ai'
  | 'experimental';

export interface FeatureFlagMeta {
  default: boolean;
  label?: string;
  description: string;
  category: FeatureFlagCategory;
}

export const FEATURE_FLAGS = {
  communityAutoAnswer: {
    default: true,
    label: 'Community Auto-Answer',
    description:
      'Auto-drafts answers to unanswered community posts from the public FAQ corpus. ' +
      'When disabled, drafts stop generating and existing drafts are not surfaced.',
    category: 'community',
  },
  communityAutoAnswerFeedbackLoop: {
    default: true,
    label: 'Community Auto-Answer Feedback Loop',
    description:
      'Learns from admin accept/reject signals on auto-answer drafts to improve future ' +
      'drafts. When disabled, feedback is still recorded but never applied.',
    category: 'community',
  },
  sessionSupport: {
    default: true,
    label: 'Session Support Tickets',
    description:
      'Lets students report issues that prevented them from attending a session ' +
      '(internet outage, device failure, etc.) with a guided troubleshooting ' +
      'checklist and proof upload. Admins get a unified inbox to triage and reply.',
    category: 'support',
  },
  goldenTicket: {
    default: false,
    label: 'Golden Ticket (Spurti Points escalation)',
    description:
      'A premium escalation channel where students spend Spurti Points (SP) to bump ' +
      'a time-sensitive query to the top of the admin queue. Higher SP = higher ' +
      'leaderboard priority. Includes a 48h cooldown between submissions. ' +
      'Experimental — toggle off to hide the /golden page and gate the backend.',
    category: 'support',
  },
  documentPipeline: {
    default: true,
    label: 'Document Processing Pipeline',
    description:
      'Enables the Redis-backed background worker (BullMQ) for document insight ' +
      'processing and OCR. When disabled, document uploads are gated and the worker ' +
      'is stopped to free up resources.',
    category: 'integrations',
  },
  faqFreshness: {
    default: true,
    label: 'FAQ Freshness Audit',
    description:
      'Periodic cron job that audits the public FAQ corpus for stale answers and ' +
      'flags them for admin review. When disabled, the freshness scheduler is stopped.',
    category: 'faq',
  },
  welcomePackage: {
    default: true,
    label: 'Welcome Package',
    description:
      'The student onboarding / orientation hub at /welcome (project discovery, ' +
      'getting-started checklist, etc.). When disabled, the nav link is hidden and ' +
      'the page shows the unavailable panel.',
    category: 'onboarding',
  },
  askAiChatbot: {
    default: false,
    label: 'Ask AI Chatbot',
    description:
      'The floating AskAI assistant button shown on non-admin pages. When disabled, ' +
      'the button is hidden from the UI. Toggle on to re-enable the chatbot for users.',
    category: 'ai',
  },
  offlineMode: {
    default: false,
    label: 'Offline Mode (PWA)',
    description:
      'Registers a service worker that caches the FAQ list and previously-visited FAQ ' +
      'detail pages so they remain viewable without a network connection, and enables ' +
      'the Web App Manifest so the site can be installed. Frontend-only — no backend ' +
      'routes are affected. When disabled, the service worker is not registered (and ' +
      'is actively unregistered if it was previously active).',
    category: 'experimental',
  },
} as const satisfies Record<string, FeatureFlagMeta>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export function isKnownFeatureFlag(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, key);
}
