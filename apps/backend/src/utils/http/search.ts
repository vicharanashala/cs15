import { Types } from 'mongoose';

export type ResultSource = 'faq' | 'community' | 'knowledge';

export interface SearchResultItem {
  _id: Types.ObjectId;
  title?: string;
  question?: string;
  answer?: string;
  body?: string;
  status?: string;
  category?: string;
  score: number;
  source: ResultSource;
  rrfScore?: number;
  vectorScore?: number;
  textScore?: number;
  // Freshness system — required for the public FreshnessBadge
  reviewStatus?: 'verified' | 'pending_review' | 'update_requested';
  lastVerifiedDate?: Date;
  reviewIntervalDays?: number;
  freshnessTier?: 'evergreen' | 'seasonal' | 'volatile';
}

export interface RRFEntry {
  doc: SearchResultItem;
  rrfScore: number;
  vectorScore: number;
  textScore: number;
}

/**
 * Reciprocal Rank Fusion — merges ranked result lists from multiple rankers.
 *
 * Standard formula: RRF_SCORE = 1 / (k + rank)
 * k=60 is the academic default (controls how much lower-ranked documents
 * from one ranker can be boosted by appearing in another ranker's results).
 */
export const RRF_K = 60;

export function computeRRF(
  vectorResults: SearchResultItem[],
  textResults: SearchResultItem[]
): SearchResultItem[] {
  const scores = new Map<string, RRFEntry>();

  vectorResults.forEach((doc, index) => {
    const id = doc._id.toString();
    const rank = index + 1;
    const rrfScore = 1 / (RRF_K + rank);
    scores.set(id, { doc, rrfScore, vectorScore: doc.score || 0, textScore: 0 });
  });

  textResults.forEach((doc, index) => {
    const id = doc._id.toString();
    const rank = index + 1;
    const rrfScore = 1 / (RRF_K + rank);

    if (scores.has(id)) {
      const entry = scores.get(id)!;
      entry.rrfScore += rrfScore;
      entry.textScore = doc.score || 0;
    } else {
      scores.set(id, { doc, rrfScore, vectorScore: 0, textScore: doc.score || 0 });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((entry) => {
      entry.doc.rrfScore = entry.rrfScore;
      entry.doc.vectorScore = entry.vectorScore;
      entry.doc.textScore = entry.textScore;
      return entry.doc;
    });
}

/**
 * Applies the platform's threshold filter to remove irrelevant results.
 * A document is kept if it has any keyword match (textScore > 0) OR
 * a strong semantic match (vectorScore > 0.80).
 */
export function applySearchThreshold(results: SearchResultItem[], threshold = 0.80): SearchResultItem[] {
  return results.filter(
    (doc) => (doc.textScore && doc.textScore > 0) || (doc.vectorScore && doc.vectorScore >= threshold)
  );
}