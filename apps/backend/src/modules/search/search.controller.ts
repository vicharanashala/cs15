import { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import SearchLog from './search-log.model.js';
import { generateQueryEmbedding } from '../../utils/ai/embeddings.js';
import { LRUCache } from 'lru-cache';
import { httpLog } from '../../utils/http/logger.js';
import { getCachedResults, setCachedResults } from '../../utils/http/cache.js';
import {
  computeRRF,
  applySearchThreshold,
  type SearchResultItem,
  type ResultSource,
} from '../../utils/http/search.js';
import { searchRequests, searchResultsReturned, searchLogFlushActive, searchLogFlushes } from '../../utils/http/metrics.js';
import { searchKnowledge } from '../knowledge/knowledge-base.service.js';
import { readSetting } from '../program/app-setting.model.js';

// Cache configuration: Store up to 500 recent queries for 1 hour to reduce DB/AI loads
const searchCache = new LRUCache<string, SearchResultItem[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

// ─── SearchLog Batch Buffer ────────────────────────────────────────────────────
// Buffers search log entries and flushes them to MongoDB in batches.
// Avoids a write-per-request on high-traffic deployments.
interface PendingLog {
  query: string;
  resultsCount: number;
  topResultId: Types.ObjectId | null;
  topResultSource: 'faq' | 'community' | 'knowledge' | null;
  // v1.68 — M1: optional userId (anonymous searches leave it null)
  userId: Types.ObjectId | null;
  createdAt: Date;
  batchId?: Types.ObjectId | null;
}

const BATCH_FLUSH_INTERVAL_MS = 5_000; // flush every 5 seconds
const BATCH_MAX_SIZE = 50;
const pendingLogs: PendingLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    searchLogFlushActive.inc();
    const logs = pendingLogs.splice(0);
    if (logs.length === 0) { searchLogFlushActive.dec(); return; }
    try {
      await SearchLog.insertMany(logs, { ordered: false });
      searchLogFlushes.inc();
    } catch (err) {
      // silently discard failed batch inserts, but log warning
      httpLog.warn(`[search] Failed to flush buffered search logs to DB: ${(err as Error).message}`);
    } finally {
      searchLogFlushActive.dec();
    }
  }, BATCH_FLUSH_INTERVAL_MS);
}

function bufferSearchLog(entry: Omit<PendingLog, 'createdAt'>): void {
  pendingLogs.push({ ...entry, createdAt: new Date() });
  if (pendingLogs.length >= BATCH_MAX_SIZE) {
    // Immediate flush when buffer is full
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const logs = pendingLogs.splice(0);
searchLogFlushActive.inc();
    SearchLog.insertMany(logs, { ordered: false })
      .then(() => {
        searchLogFlushes.inc();
      })
      .catch((err) => {
        httpLog.warn(`[search] Failed to insert buffered search logs: ${(err as Error).message}`);
      })
      .finally(() => {
        searchLogFlushActive.dec();
      });
  } else {
    scheduleFlush();
  }
}

/**
 * Flush any buffered search logs immediately.
 * Called by the graceful shutdown handler to ensure no logs are lost on exit.
 * Returns a promise that resolves when the insert (if any) completes.
 */
export async function flushSearchLogs(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pendingLogs.length === 0) return;
  const logs = pendingLogs.splice(0);
searchLogFlushActive.inc();
  try {
    await SearchLog.insertMany(logs, { ordered: false });
    searchLogFlushes.inc();
  } catch (err) {
    httpLog.warn(`[search] Failed to insert search logs on immediate flush: ${(err as Error).message}`);
  } finally {
    searchLogFlushActive.dec();
  }
}

// Helper: Executes traditional MongoDB keyword search
const runTextSearch = async (collectionName: string, queryStr: string, limit = 5, batchIdFilter: Types.ObjectId | null = null): Promise<SearchResultItem[]> => {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const collection = db.collection(collectionName);

    // v1.69 — Phase 3c: optionally pre-filter by batchId so the
    // text index only matches the active program's documents.
    const filter: Record<string, unknown> = { $text: { $search: queryStr } };
    if (batchIdFilter) filter.batchId = batchIdFilter;

    // Find documents matching text index, sort by native textScore
    return await collection.find(
      filter,
      { projection: { score: { $meta: 'textScore' } } }
    )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray() as SearchResultItem[];
  } catch (error) {
    // Fail gracefully if the text index hasn't been built yet
    httpLog.warn(`Text search on '${collectionName}' failed: ${(error as Error).message}`);
    return [];
  }
};

// Helper: Executes MongoDB Atlas Vector Search (Semantic Search)
const runVectorSearch = async (collectionName: string, queryEmbedding: number[], limit = 5, batchIdFilter: Types.ObjectId | null = null): Promise<SearchResultItem[]> => {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const collection = db.collection(collectionName);

    // v1.69 — Phase 3c: pre-filter by batchId BEFORE the
    // $vectorSearch stage. Vector search has to be the first
    // pipeline stage it touches, so a $match pre-filter is the
    // only way to scope the search to a single program. When
    // batchIdFilter is null the helper behaves as before.
    const filterObj: Record<string, unknown> = {};
    if (batchIdFilter) filterObj.batchId = batchIdFilter;

    const pipeline: Record<string, unknown>[] = [
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 10, // Over-fetch for better accuracy before limiting
          limit,
          ...(Object.keys(filterObj).length > 0 ? { filter: filterObj } : {}),
        },
      },
      {
        $project: {
          _id: 1,
          title: 1,
          question: 1,
          answer: 1,
          body: 1,
          status: 1,
          category: 1,
          helpfulVotes: 1,
          unhelpfulVotes: 1,
          score: { $meta: 'vectorSearchScore' }, // Expose similarity score
          trustLevel: 1,
          // Freshness system — required for the public FreshnessBadge
          reviewStatus: 1,
          lastVerifiedDate: 1,
          reviewIntervalDays: 1,
          freshnessTier: 1,
        },
      },
      // Boost score based on trust level: high (official) > expert (admin_approved) > medium (community_approved) > low
      {
        $addFields: {
          score: {
            $add: [
              { $meta: 'vectorSearchScore' },
              {
                $switch: {
                  branches: [
                    { case: { $eq: ['$trustLevel', 'high'] },   then: 0.15 },
                    { case: { $eq: ['$trustLevel', 'expert'] }, then: 0.07 },
                    { case: { $eq: ['$trustLevel', 'medium'] }, then: 0.02 },
                  ],
                  default: 0,
                },
              },
            ],
          },
        },
      },
    ];

    return await collection.aggregate(pipeline).toArray() as SearchResultItem[];
  } catch (error) {
    httpLog.warn(`Vector search on '${collectionName}' failed: ${(error as Error).message}`);
    return [];
  }
};

/**
 * POST /api/search
 * Main Hybrid Search Controller
 */
export const semanticSearch = async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body as { query?: string };
    // v1.68 — M1: capture the requester's userId so the
    // admin User Activity chart can show unique user counts.
    // Anonymous searches leave it null.
    const userId = (req as Request & { user?: { _id?: Types.ObjectId | string } }).user?._id ?? null;
    const userObjectId = userId
      ? (typeof userId === 'string' ? new Types.ObjectId(userId) : userId)
      : null;
    // v1.69 — Phase 3c: read the program context (attached by
    // programScope middleware) so the vector + text searches only
    // consider the active program's FAQs / posts. When the
    // context is absent (e.g. admin global search, or single-tenant
    // dev mode) the filter is a no-op.
    const programContext = req.programContext;
    const batchIdObjectId = programContext
      ? new Types.ObjectId(programContext.batchId)
      : null;

    if (!query) {
      res.status(400).json({ message: 'query string is required.' });
      return;
    }
    
    const normalizedQuery = query.trim().toLowerCase();

    // Parse custom threshold from request if provided (body or query params)
    const customThreshold = req.body.threshold !== undefined ? req.body.threshold : req.query.threshold;
    let thresholdVal: number | undefined;
    if (customThreshold !== undefined && customThreshold !== null) {
      const parsed = parseFloat(String(customThreshold));
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        thresholdVal = parsed;
      }
    }

    // Use threshold-specific cache key to prevent collision with default threshold searches
    const cacheKey = thresholdVal !== undefined ? `${normalizedQuery}:${thresholdVal}` : normalizedQuery;

    // 1. Check Redis semantic cache first (shared across all serverless instances)
    const redisCached = await getCachedResults(cacheKey);
    if (redisCached) {
      searchRequests.inc({ source: 'redis', cached: 'true' });
      searchResultsReturned.observe({ source: 'redis' }, redisCached.results.length);
      const cachedResults = redisCached.results as SearchResultItem[];
      const topResult = cachedResults[0] || null;
      bufferSearchLog({
        query,
        resultsCount: cachedResults.length,
        topResultId: topResult?._id ?? null,
        topResultSource: topResult?.source ?? null,
        userId: userObjectId,
        batchId: batchIdObjectId,
      });
      res.json({ results: cachedResults, total: cachedResults.length, cached: true });
      return;
    }

    // 2. Check LRU Cache for immediate response (process-local fallback)
    if (searchCache.has(cacheKey)) {
      const cachedResults = searchCache.get(cacheKey)!;
      await setCachedResults(cacheKey, cachedResults);
      searchRequests.inc({ source: 'lru', cached: 'true' });
      searchResultsReturned.observe({ source: 'lru' }, cachedResults.length);
      const topResult = cachedResults[0] || null;
      bufferSearchLog({
        query,
        resultsCount: cachedResults.length,
        topResultId: topResult?._id ?? null,
        topResultSource: topResult?.source ?? null,
        userId: userObjectId,
        batchId: batchIdObjectId,
      });
      res.json({ results: cachedResults, total: cachedResults.length, cached: true });
      return;
    }

    // 2. Compute AI Embedding for the search term.
    //
    // v1.71 — Phase 8 R3: NO LONGER compute the embed on every search
    // request. The audit showed repeated
    // `[knowledgeBase] Failed to generate embedding for query '...':
    //  Connection error.` log lines because every POST /api/search
    // hit the Hugging Face / local-Ollama embedder, which is
    // routinely unreachable. Now the embedding-warm cron
    // (`bootstrap/startup.ts`, every 60 minutes) is the ONLY thing
    // that calls the embedder on the search service. The search
    // itself stays text-only; the vector branch of the hybrid pipeline
    // is temporarily disabled because we have no query embedding.
    //
    // The OLD code path (kept here as a commented recipe, so future
    // maintainers can re-enable it once the embedder is reliably up):
    //
    //   try {
    //     embedding = await generateQueryEmbedding(query);
    //   } catch (embErr) {
    //     httpLog.warn('search.embedding.failed — falling back to keyword-only search', { error: embErr.message });
    //   }
    const embedding: number[] | null = null;

    // 3. Execute Vector (when an embedding is available) + Text searches in
    //    parallel across both collections for maximum speed.
    const empty = Promise.resolve([] as SearchResultItem[]);
    const [faqVec, commVec, faqTxt, commTxt] = await Promise.all([
      // Vector search is currently disabled on the per-request path
      // (see v1.71 above). Embedding here would always be null.
      // We keep the helper + call structure in place so re-enabling
      // is a one-line change: `embedding ? runVectorSearch(...) : empty`.
      empty,
      empty,
      runTextSearch('yaksha_faq_faqs', query, 5, batchIdObjectId),
      runTextSearch('yaksha_faq_communityposts', query, 5, batchIdObjectId)
    ]);
    
    // Tag results with their origin source (FAQ vs Community)
    const processResults = (results: SearchResultItem[], source: ResultSource): SearchResultItem[] => 
      results.map(r => ({ ...r, source }));
    const allVec = [...processResults(faqVec, 'faq'), ...processResults(commVec, 'community')];
    const allTxt = [...processResults(faqTxt, 'faq'), ...processResults(commTxt, 'community')];

    // 4. Merge results using Reciprocal Rank Fusion
    const merged = computeRRF(allVec, allTxt);

    // Resolve configured or custom threshold
    const searchThreshold = thresholdVal !== undefined
      ? thresholdVal
      : await readSetting('searchThreshold', 0.80, batchIdObjectId);

    // 5. Apply threshold filters to remove irrelevant garbage results
    const filtered = applySearchThreshold(merged, searchThreshold).slice(0, 5); // Return only the absolute top 5 results

    // 5b. TranscriptKnowledge fallback — if FAQ + Community returned nothing,
    // try the auto-extracted Zoom knowledge base. Zero-human data path:
    // Zoom transcript → processZoomMeetingForKnowledge → inline embed →
    // available for this exact query. Tagged source: 'knowledge' so the
    // frontend can render with a "from meeting" badge.
    //
    // v1.71 — Phase 8 R3: pass `{ embedQuery: false }` to skip the
    // per-request embed. The embedding-warm cron (hourly, see
    // `bootstrap/startup.ts`) is now responsible for keeping the
    // TranscriptKnowledge.embedding vectors fresh; the user's search
    // hits the text index only.
    if (filtered.length === 0) {
      try {
        const knowledgeHits = await searchKnowledge(query, 5, { embedQuery: false });
        if (knowledgeHits.length > 0) {
          const knowledgeResults: SearchResultItem[] = knowledgeHits.map((k) => ({
            _id: new Types.ObjectId(k._id),
            question: k.question,
            answer: k.answer,
            source: 'knowledge' as ResultSource,
            score: k.score,
          }));
          const final = knowledgeResults.slice(0, 5);
          searchCache.set(cacheKey, final);
          await setCachedResults(cacheKey, final);
          bufferSearchLog({
            query,
            resultsCount: final.length,
            topResultId: (final[0]?._id as Types.ObjectId) ?? null,
            topResultSource: 'knowledge',
            userId: userObjectId,
            batchId: batchIdObjectId,
          });
          searchRequests.inc({ source: 'fresh', cached: 'false' });
          searchResultsReturned.observe({ source: 'fresh' }, final.length);
          res.json({ results: final, total: final.length, cached: false });
          return;
        }
      } catch (e) {
        httpLog.warn('search.knowledge.fallback.failed', { error: (e as Error).message });
      }
    }

    // 6. Save to both Redis (shared) and LRU (process-local)
    searchCache.set(cacheKey, filtered);
    await setCachedResults(cacheKey, filtered);

    // 7. Buffer search log entry for batched async write (non-blocking)
    const topResult = filtered[0] || null;
    bufferSearchLog({
      query,
      resultsCount: filtered.length,
      topResultId: topResult?._id ?? null,
      topResultSource: topResult?.source ?? null,
      userId: userObjectId,
      batchId: batchIdObjectId,
    });

    searchRequests.inc({ source: 'fresh', cached: 'false' });
    searchResultsReturned.observe({ source: 'fresh' }, filtered.length);

    res.json({ results: filtered, total: filtered.length, cached: false });
  } catch (error) {
    httpLog.error('Search error', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ message: 'Search failed', /* error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined */ });
  }
};

// GET /api/search/trending
// Aggregates search logs to find the top 6 most popular queries
export const getTrending = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawBatchId = req.query.batchId || req.programContext?.batchId;
    const batchIdObjectId = typeof rawBatchId === 'string' && Types.ObjectId.isValid(rawBatchId)
      ? new Types.ObjectId(rawBatchId)
      : null;

    const pipeline: any[] = [];
    if (batchIdObjectId) {
      pipeline.push({ $match: { batchId: batchIdObjectId } });
    }

    pipeline.push(
      {
        $group: {
          _id: { $toLower: '$query' },
          count: { $sum: 1 },
          lastSearched: { $max: '$createdAt' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
      {
        $project: {
          _id: 0,
          query: '$_id',
          count: 1,
          lastSearched: 1,
        },
      }
    );

    const trending = await SearchLog.aggregate(pipeline);
    res.json({ trending });
  } catch (error) {
    res.status(500).json({ message: 'Server error', /* error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined */ });
  }
};

// GET /api/search/suggest?q=<query>
// Lightweight text-only FAQ suggestion for SearchBar dropdown — no auth required
export const getSuggest = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) {
      res.json({ suggestions: [] });
      return;
    }

    const db = mongoose.connection.db;
    if (!db) {
      res.json({ suggestions: [] });
      return;
    }

    // Escape special regex chars to prevent injection
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const results = await db
      .collection('yaksha_faq_faqs')
      .find(
        {
          question: { $regex: escaped, $options: 'i' },
          status: 'approved',
        },
        { projection: { _id: 1, question: 1, category: 1 } }
      )
      .limit(5)
      .toArray();

    res.json({ suggestions: results });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};
