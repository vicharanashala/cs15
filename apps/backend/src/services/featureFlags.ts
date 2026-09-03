// featureFlags — typed feature flag registry + service.
//
// Phase 1 R1: replaces the closed allow-list that lived in
// feature-flag.controller.ts with a typed object literal so:
//   - the union of valid keys is derived from the literal, not
//     maintained separately in `FeatureFlagKey`,
//   - every caller gets full TypeScript narrowing on flag keys,
//   - adding a flag is one entry + (optionally) one Mongo doc seed,
//   - the in-process LRU is invalidated wildcard on every write so
//     a per-program override no longer leaves stale global reads
//     behind (the cache bug from the v1.69 audit).
//
// The service is consumed by:
//   - feature-flag.controller.ts (routes)
//   - support-core.controller.ts / support-requests.controller.ts (gates)
//   - bootstrap/startup.ts (boot check + document worker gate)
//
// The same FEATURE_FLAGS object literal is mirrored on the
// frontend in apps/frontend/src/ds/featureFlags.ts. Both files must
// stay in sync — see the comment at the top of that file. A
// future R2 task should move this to a shared package.

import { LRUCache } from 'lru-cache';
import { Types } from 'mongoose';
import FeatureFlag from '../modules/program/feature-flag.model.js';
import { adminLog, startupLog } from '../utils/http/logger.js';

// ─── Typed registry ─────────────────────────────────────────────────────────

export type FeatureFlagCategory =
  | 'community'
  | 'support'
  | 'integrations'
  | 'faq'
  | 'onboarding'
  | 'ai'
  | 'experimental';

export interface FeatureFlagMeta {
  /** Default value when no override exists. */
  default: boolean;
  /** Short label for the admin UI. Optional — falls back to a
   *  humanised version of the key. */
  label?: string;
  /** Longer description for the admin "what does this do" tooltip. */
  description: string;
  /** Coarse grouping for the admin UI. */
  category: FeatureFlagCategory;
}

/**
 * The canonical feature flag registry. Every entry is the source
 * of truth for both backend runtime checks and the frontend type
 * system — if you need to know "is this flag a thing?", the answer
 * is here, and the union type below is derived from this object.
 *
 * Adding a flag: add an entry here. The startup boot check will
 * seed it in MongoDB on the next process start. No new exports or
 * type annotations are needed.
 */
export const FEATURE_FLAGS = {
  communityAutoAnswer: {
    default: true,
    label: 'Community Auto-Answer',
    description:
      'Auto-drafts answers to unanswered community posts from the public FAQ corpus. ' +
      'When disabled, drafts stop generating and existing drafts are not surfaced.',
    category: 'community',
  },
  // v1.69 P1 — was an orphan flag in MongoDB (registry missing it).
  // Mirrors communityAutoAnswer but applies to the AI suggestion path
  // specifically (legacy row kept so the existing toggle history
  // survives). Toggling communityAutoAnswer off still implies this off
  // in callers — see support-core.controller.ts for the chain.
  aiAutoAnswer: {
    default: true,
    label: 'AI Auto-Answer',
    description:
      'Enables AI-driven answer suggestions on community posts. When disabled, no AI ' +
      'drafts are generated; existing drafts remain in their current state. Mirrors ' +
      'communityAutoAnswer for backwards compatibility with legacy MongoDB rows.',
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
  // Phase 3 R12 — the askHuman fallback path. When disabled, posts
  // that fall below the suggest threshold get status='pending' (the
  // pre-Phase-3 behaviour) instead of being directly escalated for
  // human review. Boolean-only because the registry is keyed
  // on/off — the numeric threshold itself lives in AppSetting as
  // 'autoAnswerAskHumanThreshold' (default 0.30).
  communityAutoAnswerAskHumanFallback: {
    default: true,
    label: 'Community Auto-Answer — Ask-Human Fallback',
    description:
      'When ON, community posts that score below the suggest threshold are escalated ' +
      'directly for human review. When OFF, those posts are returned to the "pending" ' +
      'queue so the next batch can try again (the pre-Phase-3 behaviour).',
    category: 'community',
  },
  sessionSupport: {
    default: true,
    label: 'Session Support Tickets',
    description:
      "Lets students report issues that prevented them from attending a session " +
      "(internet outage, device failure, etc.) with a guided troubleshooting " +
      "checklist and proof upload. Admins get a unified inbox to triage and reply.",
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
  // v1.71 — Phase 8 R3: hourly embedding-warm cron. When enabled
  // (default), `bootstrap/startup.ts` registers an `embedding-warm`
  // cron that calls `embedUnprocessedKnowledge()` every 60 minutes.
  // This replaces the "embed on every search request" behaviour that
  // was hammering the embedder endpoint and producing `[knowledgeBase]
  // Failed to generate embedding for query ...` errors. The manual
  // `POST /csfaq/api/warm` endpoint is still available for ad-hoc
  // runs and is unaffected by this flag.
  embeddingWarmCron: {
    default: true,
    label: 'Embedding Warm Cron (hourly)',
    description:
      'When enabled, the server runs an hourly cron that back-fills ' +
      'missing embeddings on TranscriptKnowledge rows. Search queries ' +
      'degrade to text-only matching when this flag is off or when the ' +
      'embedder endpoint is unreachable. Disable to skip the cron (the ' +
      'manual POST /csfaq/api/warm endpoint still works).',
    category: 'ai',
  },
  // Phase 8 — auto-discover mode for the WebPage collection. When
  // enabled, the bootstrap cron (every 6h) calls webCrawler.runAutoDiscover
  // which fetches each configured seed URL, follows same-domain links
  // to depth 1, and upserts the results as `source='auto_discovered'`
  // rows with `approved: false`. An admin then has to PATCH
  // /admin/web-pages/:id/approve each row before it surfaces in the
  // retrieval fan-out. Default false so the cron never runs without
  // an explicit opt-in.
  webAutoDiscover: {
    default: false,
    label: 'Web Auto-Discover (Phase 8)',
    description:
      'When enabled, a 6-hourly cron fetches configured seed URLs and indexes them ' +
      'as `source=auto_discovered` WebPage rows with `approved=false`. Admins then ' +
      'approve each row via PATCH /admin/web-pages/:id/approve before it surfaces ' +
      'in retrieval. Leave OFF until you have reviewed which seed URLs to crawl.',
    category: 'integrations',
  },
  // v1.71 — replaces the deprecated `categoryClusterer` cron (which called a
  // local ONNX embedder that isn't running in this deployment, producing a
  // burst of `[categoryClusterer] embed failed for X: Connection error` warnings
  // every boot + 2 days). The new path uses the existing AI provider chain
  // (chatWithProvider / resolveActiveAiConfig) and writes directly to the
  // Category collection. Off by default — flip on in /admin/features once
  // you've reviewed how aggressively the LLM will rewrite your category tree.
  categoryRecategorize: {
    default: false,
    label: 'LLM FAQ Recategorize (v1.71)',
    description:
      'Every 2 days, asks the configured LLM to re-assign each approved FAQ to the ' +
      'best category. Creates new categories as needed. OFF by default — turning this ' +
      'on will overwrite existing FAQ `category` assignments based on LLM output, so ' +
      'review a dry run first via the admin schedule UI.',
    category: 'faq',
  },
} as const satisfies Record<string, FeatureFlagMeta>;

/** Union of every registered flag key. Derived from the registry so
 *  the two can never drift. */
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/** Returns true when the key is part of the registry. */
export function isKnownFeatureFlag(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, key);
}

// ─── Source labels ──────────────────────────────────────────────────────────

export type FeatureFlagSource = 'global' | 'override' | 'default';

export interface ResolvedFeatureFlag {
  key: FeatureFlagKey;
  /** Resolved boolean — what callers should branch on. */
  enabled: boolean;
  /** Where the resolved value came from. */
  source: FeatureFlagSource;
  /** Last flip timestamp (UTC), or null if never toggled. */
  lastChangedAt: Date | null;
  /** Last user to flip this flag (resolved), or null. */
  lastChangedBy: { _id: Types.ObjectId; name?: string; email?: string } | null;
}

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * 30 s TTL — same as the previous implementation, but the audit
 * noted that per-program override writes were leaving stale global
 * reads for up to 30 s. The fix: invalidate the ENTIRE cache on
 * every write (see #invalidateAll). The 30 s TTL is now only a
 * safety net for the case where the cache is never invalidated
 * (e.g. an admin mutates MongoDB directly via the shell).
 */
const CACHE_TTL_MS = 30_000;
/** Hard cap on cached entries — far above the realistic working
 *  set (a handful of flags × programs in flight). */
const CACHE_MAX = 5_000;

export class UnknownFeatureFlagError extends Error {
  constructor(key: string) {
    super(`Unknown feature flag: ${key}`);
    this.name = 'UnknownFeatureFlagError';
  }
}

export interface ListAllOptions {
  /** Limit `source: 'override'` checks to this program. */
  batchId?: Types.ObjectId | string | null;
}

export class FeatureFlags {
  private readonly cache = new LRUCache<string, boolean>({
    max: CACHE_MAX,
    ttl: CACHE_TTL_MS,
    ttlAutopurge: false,
  });

  /** Asserts a key exists in the registry. Throws at runtime if not. */
  private assertKnown(key: string): asserts key is FeatureFlagKey {
    if (!isKnownFeatureFlag(key)) {
      throw new UnknownFeatureFlagError(key);
    }
  }

  /** Cache key: `key` for the global scope, `key::batchId` for the
   *  per-program scope. Stable across string/ObjectId inputs. */
  private cacheKey(key: FeatureFlagKey, batchId?: string | null): string {
    return batchId ? `${key}::${batchId}` : key;
  }

  /** Wildcard invalidation — called from every public mutator.
   *  Always clears the entire cache because per-program writes
   *  invalidate the global slot's TTL guarantees too. The audit
   *  flagged the old per-key `_cache.delete(key)` as a 30 s
   *  staleness window for per-program overrides. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Resolve whether a flag is enabled for an optional program.
   *
   * Resolution chain:
   *   1. Per-program override (key, batchId)
   *   2. Global default (key, batchId = null)
   *   3. Registry default (FEATURE_FLAGS[key].default)
   */
  async isEnabled(key: FeatureFlagKey, batchId?: string | null): Promise<boolean> {
    this.assertKnown(key);
    const ck = this.cacheKey(key, batchId ?? null);
    const cached = this.cache.get(ck);
    if (cached !== undefined) return cached;

    const flag = await this.fetchRaw(key, batchId ?? null);
    let enabled: boolean;
    if (flag) {
      enabled = !!flag.enabled;
    } else {
      enabled = FEATURE_FLAGS[key].default;
    }
    this.cache.set(ck, enabled);
    return enabled;
  }

  /** Internal: read a single (key, batchId) doc. */
  private async fetchRaw(
    key: FeatureFlagKey,
    batchId: string | null,
  ): Promise<{
    enabled: boolean;
    updatedAt: Date;
    updatedBy: Types.ObjectId | null;
  } | null> {
    const query: Record<string, unknown> = { key };
    if (batchId) {
      query.batchId = Types.ObjectId.isValid(batchId)
        ? new Types.ObjectId(batchId)
        : null;
    } else {
      query.batchId = null;
    }
    const doc = await FeatureFlag.findOne(query)
      .select('enabled updatedAt updatedBy batchId')
      .lean();
    return doc as Awaited<ReturnType<typeof this.fetchRaw>>;
  }

  /** Set the global default for a flag. */
  async setGlobal(
    key: FeatureFlagKey,
    enabled: boolean,
    updatedBy?: Types.ObjectId | string | null,
  ): Promise<void> {
    this.assertKnown(key);
    const now = new Date();
    await FeatureFlag.updateOne(
      { key, batchId: null },
      {
        $set: {
          enabled,
          updatedBy: updatedBy ? new Types.ObjectId(String(updatedBy)) : null,
          updatedAt: now,
          ...(enabled ? { firstEnabledAt: now } : { lastDisabledAt: now }),
        },
        $setOnInsert: {
          key,
          batchId: null,
          label: FEATURE_FLAGS[key].label ?? null,
          description: FEATURE_FLAGS[key].description,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    this.invalidateAll();
    adminLog.info(`[featureFlags] ${key} → ${enabled ? 'enabled' : 'disabled'} (global)`);
  }

  /** Set the per-program override for a flag. The override wins
   *  over the global default in isEnabled() for that program. */
  async setProgramOverride(
    key: FeatureFlagKey,
    batchId: Types.ObjectId | string,
    enabled: boolean,
    updatedBy?: Types.ObjectId | string | null,
  ): Promise<void> {
    this.assertKnown(key);
    const bid = new Types.ObjectId(String(batchId));
    const now = new Date();
    await FeatureFlag.updateOne(
      { key, batchId: bid },
      {
        $set: {
          enabled,
          updatedBy: updatedBy ? new Types.ObjectId(String(updatedBy)) : null,
          updatedAt: now,
          ...(enabled ? { firstEnabledAt: now } : { lastDisabledAt: now }),
        },
        $setOnInsert: {
          key,
          batchId: bid,
          label: FEATURE_FLAGS[key].label ?? null,
          description: FEATURE_FLAGS[key].description,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    this.invalidateAll();
    adminLog.info(
      `[featureFlags] ${key} → ${enabled ? 'enabled' : 'disabled'} (program ${String(bid)})`,
    );
  }

  /** Remove the per-program override. Falls back to the global
   *  default on the next isEnabled() call. */
  async clearProgramOverride(
    key: FeatureFlagKey,
    batchId: Types.ObjectId | string,
  ): Promise<void> {
    this.assertKnown(key);
    const bid = new Types.ObjectId(String(batchId));
    await FeatureFlag.deleteOne({ key, batchId: bid });
    this.invalidateAll();
    adminLog.info(`[featureFlags] ${key} override cleared (program ${String(bid)})`);
  }

  /** Return the merged view of every registered flag for the
   *  optional program. */
  async listAll(opts: ListAllOptions = {}): Promise<ResolvedFeatureFlag[]> {
    const { batchId } = opts;
    const bid =
      batchId == null
        ? null
        : batchId instanceof Types.ObjectId
          ? batchId
          : Types.ObjectId.isValid(String(batchId))
            ? new Types.ObjectId(String(batchId))
            : null;

    // Pull overrides + globals in a single round trip.
    const docs = await FeatureFlag.find(
      bid ? { $or: [{ batchId: bid }, { batchId: null }] } : { batchId: null },
    )
      .select('key enabled updatedAt updatedBy batchId')
      .lean();

    const byKey = new Map<string, { enabled: boolean; updatedAt: Date; updatedBy: Types.ObjectId | null; batchId: Types.ObjectId | null }>();
    for (const d of docs) {
      // per-program wins over global default for the same key
      const existing = byKey.get(d.key);
      if (!existing) {
        byKey.set(d.key, {
          enabled: d.enabled,
          updatedAt: d.updatedAt,
          updatedBy: d.updatedBy ?? null,
          batchId: d.batchId ?? null,
        });
        continue;
      }
      // if existing is global and incoming is per-program, prefer incoming
      if (existing.batchId == null && d.batchId != null) {
        byKey.set(d.key, {
          enabled: d.enabled,
          updatedAt: d.updatedAt,
          updatedBy: d.updatedBy ?? null,
          batchId: d.batchId ?? null,
        });
      }
    }

    // Optional population of updatedBy (kept light — only when present).
    const userIds = Array.from(
      new Set(
        Array.from(byKey.values())
          .map((v) => v.updatedBy)
          .filter((id): id is Types.ObjectId => !!id),
      ),
    );
    const userMap = new Map<string, { _id: Types.ObjectId; name?: string; email?: string }>();
    if (userIds.length > 0) {
      const User = (await import('../modules/auth/user.model.js')).default;
      const users = await User.find({ _id: { $in: userIds } })
        .select('_id name email')
        .lean();
      for (const u of users) {
        userMap.set(String(u._id), { _id: u._id, name: u.name, email: u.email });
      }
    }

    return (Object.keys(FEATURE_FLAGS) as FeatureFlagKey[]).map((key) => {
      const row = byKey.get(key);
      if (!row) {
        return {
          key,
          enabled: FEATURE_FLAGS[key].default,
          source: 'default' as const,
          lastChangedAt: null,
          lastChangedBy: null,
        };
      }
      const source: FeatureFlagSource = row.batchId != null ? 'override' : 'global';
      return {
        key,
        enabled: row.enabled,
        source,
        lastChangedAt: row.updatedAt,
        lastChangedBy: row.updatedBy
          ? userMap.get(String(row.updatedBy)) ?? { _id: row.updatedBy }
          : null,
      };
    });
  }
}

/** Singleton — shared across the process. Tests that need isolation
 *  can `new FeatureFlags()` instead. */
export const featureFlags = new FeatureFlags();

// ─── Boot helpers ───────────────────────────────────────────────────────────

/**
 * Synchronise MongoDB with the registry. Called once at startup.
 *
 *   - Registry has a flag MongoDB doesn't → seed with `default`.
 *   - MongoDB has a flag the registry doesn't → log a warning and
 *     leave the orphan alone (we don't want to delete data
 *     silently, and orphans are usually harmless).
 *
 * Returns counts for logging.
 */
export async function syncFeatureFlagRegistry(): Promise<{
  seeded: string[];
  orphans: string[];
}> {
  const registryKeys = new Set<string>(Object.keys(FEATURE_FLAGS));
  const mongoKeys = new Set<string>(
    (await FeatureFlag.find({}, { key: 1, batchId: 1 }).lean()).map((d) => d.key),
  );

  const seeded: string[] = [];
  for (const key of registryKeys) {
    if (!mongoKeys.has(key)) {
      const meta = FEATURE_FLAGS[key as FeatureFlagKey];
      await FeatureFlag.updateOne(
        { key, batchId: null },
        {
          $setOnInsert: {
            key,
            batchId: null,
            enabled: meta.default,
            label: meta.label ?? null,
            description: meta.description,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
      seeded.push(key);
    }
  }

  const orphans: string[] = [];
  for (const key of mongoKeys) {
    if (!registryKeys.has(key)) {
      orphans.push(key);
    }
  }

  if (seeded.length > 0) {
    startupLog.info(`[featureFlags] seeded ${seeded.length} flag(s) into MongoDB: ${seeded.join(', ')}`);
  }
  if (orphans.length > 0) {
    startupLog.warn(
      `[featureFlags] ${orphans.length} orphan flag(s) in MongoDB not present in registry: ${orphans.join(', ')}. ` +
        `Add them to FEATURE_FLAGS or clean them up manually.`,
    );
  }
  return { seeded, orphans };
}