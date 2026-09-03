import mongoose, { Types } from 'mongoose';
import CommunityPost, { ICommunityPost } from './community-post.model.js';
import { generateQueryEmbedding } from '../../utils/ai/embeddings.js';
import { Request, Response } from 'express';
import { computeRRF, applySearchThreshold, type SearchResultItem } from '../../utils/http/search.js';
// v1.69 — Phase 3h: program-scope the community search.
import { withProgramScope } from '../../utils/db/scopedQuery.js';
import { communityLog } from '../../utils/http/logger.js';
import { readSetting } from '../program/app-setting.model.js';

const COLLECTION_NAME = CommunityPost.collection.name;

async function runTextSearch(queryStr: string, limit = 10): Promise<SearchResultItem[]> {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const collection = db.collection(COLLECTION_NAME);

    return await collection
      .find(
        { $text: { $search: queryStr } },
        {
          projection: {
            score: { $meta: 'textScore' },
            title: 1,
            body: 1,
            author: 1,
            status: 1,
            answer: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        }
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray() as SearchResultItem[];
  } catch (error) {
    communityLog.warn(`Text search on '${COLLECTION_NAME}' failed: ${(error as Error).message}`);
    return [];
  }
}

async function runVectorSearch(queryEmbedding: number[], limit = 10): Promise<SearchResultItem[]> {
  try {
    const db = mongoose.connection.db;
    if (!db) return [];
    const collection = db.collection(COLLECTION_NAME);

    return await collection
      .aggregate([
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'embedding',
            queryVector: queryEmbedding,
            numCandidates: limit * 10,
            limit,
          },
        },
        {
          $project: {
            _id: 1,
            title: 1,
            body: 1,
            author: 1,
            status: 1,
            answer: 1,
            createdAt: 1,
            updatedAt: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ])
      .toArray() as SearchResultItem[];
  } catch (error) {
    communityLog.warn(`Vector search on '${COLLECTION_NAME}' failed: ${(error as Error).message}`);
    return [];
  }
}

export const searchCommunityPosts = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = String(req.query.q || '').trim();

    const rawBatchId = req.query.batchId;
    const batchIdParam = rawBatchId === 'all'
      ? null
      : (rawBatchId as string | undefined || req.programContext?.batchId?.toString() || null);
    if (!q) {
      const posts = await CommunityPost.find(withProgramScope({}, batchIdParam))
        .select('-embedding')
        .populate('author', 'name')
        .populate('batchId', 'name')
        .populate('comments.author', 'name')
        .sort({ createdAt: -1 })
        .limit(30);

      res.json({ results: posts, total: posts.length, query: q });
      return;
    }

    // v1.71 — Phase 8 R3: do NOT block the community search on the
    // embedder. Previously every `/api/community/search?q=...` call
    // hit `generateQueryEmbedding`, which produced repeated connection
    // errors when the embedder endpoint was unreachable. Now we
    // attempt the embed in a try/catch; if it fails we degrade to
    // text-only matching (the text index + RRF still return useful
    // results). The hourly `embedding-warm` cron back-fills any
    // missing knowledge-base embeddings in the background.
    let embedding: number[] | null = null;
    try {
      embedding = await generateQueryEmbedding(q);
    } catch (embErr) {
      communityLog.warn(
        `[communitySearch] Failed to generate embedding for query '${q}': ${(embErr as Error).message}. Falling back to text-only search.`,
      );
      embedding = null;
    }

    const [vectorResults, textResults] = await Promise.all([
      embedding ? runVectorSearch(embedding, 10) : Promise.resolve([] as SearchResultItem[]),
      runTextSearch(q, 10),
    ]);

    const merged = computeRRF(vectorResults, textResults);

    // Resolve configured or custom threshold
    const customThreshold = req.query.threshold;
    let thresholdVal: number | undefined;
    if (customThreshold !== undefined && customThreshold !== null) {
      const parsed = parseFloat(String(customThreshold));
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        thresholdVal = parsed;
      }
    }
    const searchThreshold = thresholdVal !== undefined
      ? thresholdVal
      : await readSetting('searchThreshold', 0.80, batchIdParam);

    const filtered = applySearchThreshold(merged, searchThreshold)
      .slice(0, 20);

    const ids = filtered.map((d) => d._id);
    const hydrated = await CommunityPost.find(withProgramScope({ _id: { $in: ids } }, batchIdParam))
      .select('-embedding')
      .populate('author', 'name')
      .populate('batchId', 'name')
      .populate('comments.author', 'name');

    const hydratedMap = new Map(hydrated.map((doc) => [doc._id.toString(), doc]));

    const results = filtered
      .map((item) => {
        const doc = hydratedMap.get(item._id.toString());
        if (!doc) return null;
        return { ...doc.toObject(), score: item.rrfScore, source: 'community' };
      })
      .filter(Boolean);

    res.json({ results, total: results.length, query: q });
  } catch (error) {
    res.status(500).json({ message: 'Search failed', /* error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined */ });
  }
};