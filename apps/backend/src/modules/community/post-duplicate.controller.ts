/**
 * postDuplicateController.ts
 *
 * Handles duplicate detection for community posts and FAQs.
 * Extracted from postController.ts (was lines 711–981).
 *
 * Detection layers:
 *  1. Vector similarity (embedding cosine) against approved FAQs
 *  2. TF-IDF Jaccard text match against approved FAQs
 *  3. Keyword overlap against existing community posts
 *  4. AI-powered semantic detection (primary, via detectDuplicatesWithAI)
 *  5. Knowledge base search as fallback
 */

import { Request, Response } from 'express';
import FAQ from '../faq/faq.model.js';
import CommunityPost from './community-post.model.js';
import { generateQueryEmbedding } from '../../utils/ai/embeddings.js';
import { detectDuplicatesWithAI } from '../../utils/ai/duplicateDetector.js';
import { resolveProviderAsync } from '../../utils/ai/aiProvider.js';
import { communityLog } from '../../utils/http/logger.js';
// v1.69 — Phase 3f: program-scope the duplicate detection search.
import { withProgramScope } from '../../utils/db/scopedQuery.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────

export const DUPLICATE_VECTOR_THRESHOLD = 0.85;
export const DUPLICATE_TEXT_THRESHOLD = 0.50;
export const DUPLICATE_SHORT_QUERY_THRESHOLD = 0.90;

/**
 * Minimum score for a FAQ match to block post submission.
 *
 * Mirrors the frontend rule in `CreatePostDialog.tsx`:
 *   `matches.some(m => m.source === 'faq' && m.score >= 0.85)`
 *
 * Community and knowledge matches NEVER block — they appear as suggestions
 * only. This keeps server-side enforcement consistent with what the user
 * saw in the pre-check: if the frontend allowed submit, the backend agrees.
 */
export const DUPLICATE_FAQ_BLOCK_THRESHOLD = 0.85;

/** Whether a match should block post submission. See DUPLICATE_FAQ_BLOCK_THRESHOLD. */
export function isBlockingMatch(m: DuplicateMatch): boolean {
  return m.source === 'faq' && m.score >= DUPLICATE_FAQ_BLOCK_THRESHOLD;
}

// ─── Stop words & generic terms ────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'is', 'it', 'to', 'of', 'in', 'for', 'on', 'with',
  'my', 'we', 'you', 'do', 'can', 'be', 'are', 'as', 'at', 'by', 'if', 'or',
  'not', 'how', 'what', 'when', 'where', 'why', 'will', 'get', 'got', 'have',
  'has', 'had', 'do', 'does', 'did', 'this', 'that', 'these', 'those', 'from',
  'up', 'out', 'about', 'who', 'which', 'but', 'they', 'he', 'she', 'his', 'her',
  'all', 'some', 'any', 'would', 'could', 'should', 'there', 'here', 'their',
  'them', 'been', 'being', 'am', 'was', 'were', 'so', 'no', 'yes', 'may',
  'please', 'thanks', 'thank', 'hi', 'hello', 'hey', 'dear', 'sorry',
  // common programming/generic terms that add noise in this domain
  'access', 'server', 'servers', 'production', 'access',
  'use', 'using', 'used', 'want', 'need', 'like', 'just', 'also', 'one',
  'two', 'new', 'know', 'work', 'working', 'help', 'question',
]);

const GENERIC_TERMS = new Set([
  'offer', 'letter', 'access', 'server', 'production', 'question',
  'help', 'issue', 'problem', 'error', 'please', 'thanks', 'urgent',
]);

// ─── Public interface ──────────────────────────────────────────────────────────

export interface DuplicateMatch {
  _id: string;
  title: string;
  question?: string;
  answer?: string;
  body?: string;
  score: number;
  source: 'faq' | 'community' | 'knowledge';
  sourceTitle?: string;
  confidence?: number;
  reason?: string;
  matchType: 'vector' | 'text' | 'ai';
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWord(w: string): string {
  return w.replace(/(ing|s|ed|es|e)$/, '').toLowerCase();
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !GENERIC_TERMS.has(w));
}

function wordOverlap(
  queryWords: string[],
  targetWords: string[]
): { overlap: number; total: number; jaccard: number } {
  const qSet = new Set(queryWords.map(normalizeWord));
  const tSet = new Set(targetWords.map(normalizeWord));
  const qNorm = new Set([...qSet].filter((w) => !GENERIC_TERMS.has(w)));
  const tNorm = new Set([...tSet].filter((w) => !GENERIC_TERMS.has(w)));

  let overlap = 0;
  for (const w of qNorm) {
    if (tNorm.has(w)) overlap++;
  }
  const total = Math.min(qNorm.size, tNorm.size);
  const jaccard = total > 0 ? overlap / total : 0;
  return { overlap, total, jaccard };
}

function textMatchScore(query: string, target: string): number {
  const qWords = significantWords(query);
  const tWords = significantWords(target);
  if (qWords.length === 0 || tWords.length === 0) return 0;
  const { overlap, jaccard } = wordOverlap(qWords, tWords);
  if (overlap < 2) return 0;
  const qSet = new Set(qWords);
  const tSet = new Set(tWords);
  const overlapRatio =
    [...qSet].filter((w) => tSet.has(normalizeWord(w))).length / qSet.size;
  return Math.min(1, jaccard * 0.5 + overlapRatio * 0.5);
}

// ─── checkDuplicate (pure fallback — used when AI is unavailable) ──────────────

export async function checkDuplicate(
  query: string,
  isShortQuery: boolean,
  batchId: string | null = null,
): Promise<DuplicateMatch[]> {
  const matches: DuplicateMatch[] = [];
  const lower = query.toLowerCase().trim();

  // 1. FAQ hybrid search (vector + text)
  try {
    const queryEmbedding = await generateQueryEmbedding(query).catch((err) => {
      communityLog.warn(`[postDuplicate] Failed to generate embedding for duplicate check query: ${(err as Error).message}`);
      return null;
    });
    const vectorThreshold = isShortQuery
      ? DUPLICATE_SHORT_QUERY_THRESHOLD
      : DUPLICATE_VECTOR_THRESHOLD;

    const [vectorResults, textResults] = await Promise.all([
      // Vector similarity
      queryEmbedding
        ? FAQ.find(withProgramScope({ embedding: { $exists: true, $ne: null }, status: 'approved' }, batchId))
            .select('_id question answer category embedding')
            .lean()
            .then((faqs) => {
              const scored = faqs
                .map((f) => {
                  const dot = (f.embedding as number[]).reduce(
                    (s: number, v: number, i: number) => s + v * queryEmbedding[i],
                    0
                  );
                  return { faq: f, similarity: dot };
                })
                .filter((x) => x.similarity >= vectorThreshold)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, 5);
              return scored.map((x) => ({
                _id: x.faq._id.toString(),
                title: x.faq.question,
                question: x.faq.question,
                answer: x.faq.answer,
                category: x.faq.category,
                score: x.similarity,
                matchType: 'vector' as const,
              }));
            })
        : Promise.resolve([]),

      // TF-IDF Jaccard
      FAQ.find(withProgramScope({ status: 'approved' }, batchId))
        .select('_id question answer category')
        .lean()
        .then((faqs) => {
          const scored = faqs
            .map((f) => ({
              faq: f,
              score: textMatchScore(lower, f.question + ' ' + (f.answer ?? '')),
            }))
            .filter((x) => x.score >= DUPLICATE_TEXT_THRESHOLD)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          return scored.map((x) => ({
            _id: x.faq._id.toString(),
            title: x.faq.question,
            question: x.faq.question,
            answer: x.faq.answer,
            category: x.faq.category,
            score: x.score,
            matchType: 'text' as const,
          }));
        }),
    ]);

    const seenFaq = new Set<string>();
    for (const r of [...vectorResults, ...textResults]) {
      if (!seenFaq.has(r._id)) {
        seenFaq.add(r._id);
        matches.push({ ...r, source: 'faq' });
      }
    }
  } catch (err) {
    communityLog.warn(`FAQ duplicate check failed: ${(err as Error).message}`);
  }

  // 2. Community post keyword search
  try {
    const qWords = significantWords(lower);
    if (qWords.length > 0) {
      const textResults = await CommunityPost.find(withProgramScope({
        $or: [
          { title: { $regex: escapeRegex(lower), $options: 'i' } },
          ...qWords.slice(0, 8).map((w) => ({
            title: { $regex: `\\b${escapeRegex(w)}\\b`, $options: 'i' },
          })),
        ],
      }, batchId))
        .select('_id title body status')
        .lean()
        .then((posts) => {
          const scored = posts
            .map((p) => ({
              post: p,
              score: textMatchScore(lower, p.title + ' ' + (p.body ?? '')),
            }))
            .filter((x) => x.score >= DUPLICATE_TEXT_THRESHOLD)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          return scored.map((x) => ({
            _id: x.post._id.toString(),
            title: x.post.title,
            body: x.post.body,
            status: x.post.status,
            score: x.score,
            matchType: 'text' as const,
          }));
        });

      const seenComm = new Set<string>();
      for (const r of textResults) {
        if (!seenComm.has(r._id)) {
          seenComm.add(r._id);
          matches.push({ ...r, source: 'community' });
        }
      }
    }
  } catch (err) {
    communityLog.warn(`Community duplicate check failed: ${(err as Error).message}`);
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ─── Shared AI-aware evaluator ─────────────────────────────────────────────────

/**
 * AI-aware duplicate evaluation. Used by BOTH the `/check-duplicate` route
 * handler and the `createPost` server-side check, so server enforcement
 * matches the frontend pre-check exactly.
 *
 * Architecture: when ANY AI provider is configured, the AI is the SOLE
 * evaluator. Its verdict is final — no knowledge base mixing, no keyword
 * fallback. The AI returns nothing if the question is genuinely novel.
 *
 * KB + keyword heuristics are only used when no AI provider is configured
 * (server running with no API keys at all). This keeps the AI's judgment
 * uncontested and prevents low-quality KB noise from polluting results
 * the AI has already evaluated.
 *
 * Edge cases handled:
 *  - AI configured + returns matches → caller decides blocking (see isBlockingMatch)
 *  - AI configured + returns []      → no duplicates, submission allowed
 *  - AI configured + throws/times out → caught by detectDuplicatesWithAI → returns []
 *  - No AI + KB returns matches    → caller decides blocking
 *  - No AI + KB empty + keyword fallback → caller decides blocking
 *  - batchId threads to keyword fallback only (AI is not yet program-scoped,
 *    per v1.69 Phase 3f comment in checkDuplicateController)
 */
export async function evaluateDuplicates(
  query: string,
  batchId: string | null = null,
): Promise<DuplicateMatch[]> {
  let aiAvailable = false;
  try {
    await resolveProviderAsync();
    aiAvailable = true;
  } catch {
    aiAvailable = false;
  }

  let matches: DuplicateMatch[] = [];

  if (aiAvailable) {
    matches = await detectDuplicatesWithAI(query);
  } else {
    // No AI configured — use knowledge base + keyword fallback
    try {
      const { searchKnowledge } = await import('../knowledge/knowledge-base.service.js');
      const knowledgeMatches = await searchKnowledge(query, 3);
      for (const km of knowledgeMatches) {
        if (km.score < 0.50) continue;
        matches.push({
          _id: km._id,
          title: km.question,
          question: km.question,
          answer: km.answer,
          source: 'knowledge' as const,
          sourceTitle: km.sourceTitle,
          score: km.score,
          confidence: km.confidence,
          reason: km.reason ?? `From ${km.source}: ${km.answer}`,
          matchType: 'ai' as const,
        });
      }
    } catch (err) {
      communityLog.warn(`[checkDuplicate] knowledge search failed: ${(err as Error).message}`);
    }

    // Keyword heuristics if knowledge base is also empty
    if (matches.length === 0) {
      const words = query.split(' ').filter((w) => w.length >= 3);
      const isShortQuery = words.length < 3;
      matches = await checkDuplicate(query, isShortQuery, batchId);
    }
  }

  // Sort + dedupe by _id, return top 5
  const seen = new Set<string>();
  const deduped: DuplicateMatch[] = [];
  for (const m of matches.sort((a, b) => b.score - a.score)) {
    if (!seen.has(m._id)) {
      seen.add(m._id);
      deduped.push(m);
    }
  }
  return deduped.slice(0, 5);
}

// ─── Route handler ─────────────────────────────────────────────────────────────

// POST /api/community/check-duplicate
export const checkDuplicateController = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ message: 'Not authorized' });
    return;
  }
  try {
    const { query } = req.body as { query?: string };
    if (!query?.trim()) {
      res.json({ isDuplicate: false, matches: [] });
      return;
    }

    const q = query.trim();
    const matches = await evaluateDuplicates(q, req.programContext?.batchId ?? null);

    res.json({
      isDuplicate: matches.length > 0,
      matches,
      matchCount: matches.length,
    });
  } catch (error) {
    res.status(500).json({ message: 'Duplicate check failed' });
  }
};

/**
 * POST /api/community/resolve-deflection
 * Records a user's confirmation that a suggested match solved their question,
 * deflecting post creation and optionally rewarding the author.
 */
export const resolveDeflectionController = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ message: 'Not authorized' });
    return;
  }
  try {
    const { matchId, matchType, title } = req.body as {
      matchId?: string;
      matchType?: 'faq' | 'community' | 'knowledge';
      title?: string;
    };

    communityLog.info(
      `[deflection] User ${req.user._id} resolved question "${title || ''}" using ${matchType || 'unknown'} match ${matchId || 'none'}`
    );

    // If deflected via a community post, credit the post author with reputation
    if (matchType === 'community' && matchId) {
      try {
        const post = await CommunityPost.findById(matchId).select('author').lean();
        if (post?.author) {
          const { reputationService } = await import('../../services/reputation.service.js');
          await reputationService.award({
            userId: post.author,
            batchId: req.programContext?.batchId ?? null,
            action: 'answer_accepted',
            points: 5,
            reason: 'Community post deflected a new duplicate question',
          });
        }
      } catch (err) {
        communityLog.warn(`[deflection] Failed to award deflection points: ${(err as Error).message}`);
      }
    }

    res.json({
      success: true,
      message: 'Deflection recorded successfully. Thank you for avoiding duplicate questions!',
    });
  } catch (error) {
    communityLog.error(`[deflection] Error recording deflection: ${(error as Error).message}`);
    res.status(500).json({ message: 'Failed to record deflection' });
  }
};