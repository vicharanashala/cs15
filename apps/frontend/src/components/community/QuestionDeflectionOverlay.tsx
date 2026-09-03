import React, { useState } from 'react';

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
}

interface QuestionDeflectionOverlayProps {
  matches: DuplicateMatch[];
  queryTitle: string;
  onDeflected: (match: DuplicateMatch) => void;
  checking: boolean;
}

export default function QuestionDeflectionOverlay({
  matches,
  onDeflected,
  checking,
}: QuestionDeflectionOverlayProps) {
  const [expandedId, setExpandedId] = useState<string | null>(matches[0]?._id ?? null);

  if (checking) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-ink-soft bg-mist rounded-xl border border-border animate-pulse mb-3">
        <svg className="w-3.5 h-3.5 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Checking for existing answers across FAQs and community...</span>
      </div>
    );
  }

  if (!matches || matches.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-accent/30 bg-accent/5 p-3.5 shadow-sm transition-all">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white text-[10px] font-bold">
            ⚡
          </span>
          <h4 className="text-xs font-semibold text-ink">
            Instant Matches Found ({matches.length})
          </h4>
        </div>
        <span className="text-[11px] text-ink-soft">
          Check below before posting
        </span>
      </div>

      <div className="space-y-2">
        {matches.map((match) => {
          const isExpanded = expandedId === match._id;
          const matchPercentage = Math.round((match.score || 0.8) * 100);
          const answerText = match.answer || match.body || match.reason || 'No detailed text preview available.';

          return (
            <div
              key={match._id}
              className={`rounded-lg border bg-card p-3 transition-all ${
                isExpanded ? 'border-accent/40 shadow-sm' : 'border-border hover:border-border/80'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : match._id)}
                  className="flex-1 text-left group"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${
                        match.source === 'faq'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : match.source === 'community'
                          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                          : 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                      }`}
                    >
                      {match.source === 'faq' ? 'FAQ Match' : match.source === 'community' ? 'Community Answer' : 'Knowledge Base'}
                    </span>
                    <span className="text-[10px] text-ink-faint font-mono">
                      {matchPercentage}% similarity
                    </span>
                  </div>
                  <h5 className="text-xs font-medium text-ink group-hover:text-accent transition-colors line-clamp-2">
                    {match.title || match.question}
                  </h5>
                </button>

                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : match._id)}
                  className="p-1 text-ink-faint hover:text-ink transition-colors"
                  aria-label="Toggle answer preview"
                >
                  <svg
                    className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>

              {isExpanded && (
                <div className="mt-2.5 pt-2.5 border-t border-border/60 text-xs text-ink-soft space-y-3">
                  <div className="max-h-36 overflow-y-auto whitespace-pre-line pr-1 leading-relaxed text-[11px] text-ink/90 bg-mist/50 p-2.5 rounded-lg border border-border/40">
                    {answerText}
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      Does this answer your question?
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeflected(match)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium shadow-sm transition-all active:scale-[0.98]"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                      </svg>
                      This Solved My Question!
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
