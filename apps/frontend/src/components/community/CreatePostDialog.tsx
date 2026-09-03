import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QuestionDeflectionOverlay, { type DuplicateMatch } from './QuestionDeflectionOverlay';
import Button from '../ui/Button';

import api, { friendlyError } from '../../utils/api';
import type { Post } from '../../types/ui';

import { useAuth } from '../../hooks/useAuth';
import { useAuthModal } from '../../context/AuthModalContext';
import { useGcsUpload, type GcsAsset } from '../../hooks/useGcsUpload';
import { buildGcsTransformedUrl } from '../../utils/gcsTransform';
import { useBatch } from '../../context/BatchContext';
import { useCategories } from '../explore/usePublicFaqApi';
import {
  communityTemplateCard,
  communityTemplateLabel,
  communityTemplateIcon,
  communityToastWarn,
} from '../../styles/style_config';

function CategoryDropdown({
  value,
  categories,
  onChange,
  placeholder = 'Select a category'
}: {
  value: string;
  categories: string[];
  onChange: (val: string) => void;
  placeholder?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const uniqueCategories = categories.filter(Boolean);

  const displayLabel = value === '__other__'
    ? 'Other (Enter custom name)...'
    : (value || placeholder);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl border border-border bg-mist text-sm text-ink outline-none focus:ring-2 focus:ring-accent/25 focus:bg-card transition-colors text-left"
      >
        <span className={value ? 'text-ink' : 'text-ink-faint'}>{displayLabel}</span>
        <svg className={`w-4 h-4 text-ink-faint transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl border border-border bg-bg-secondary shadow-lg z-50 py-1">
          {uniqueCategories.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => {
                onChange(cat);
                setIsOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-mist transition-colors ${value === cat ? 'bg-mist font-medium text-accent' : 'text-ink'}`}
            >
              {cat}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              onChange('__other__');
              setIsOpen(false);
            }}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-mist transition-colors border-t border-border/50 ${value === '__other__' ? 'bg-mist font-medium text-accent' : 'text-ink'}`}
          >
            Other (Enter custom name)...
          </button>
        </div>
      )}
    </div>
  );
}

interface DuplicateMatch {
  source: string;
  score: number;
  // Other fields are server-defined; we only consume these two.
  [k: string]: unknown;
}

interface CreatePostDialogProps {
  onClose: () => void;
  onCreated: (post: Post, dupResult?: { isDuplicate: boolean; dupCount: number; faqMatches: number }) => void;
  prefillTitle?: string;
}

export default function CreatePostDialog({ onClose, onCreated, prefillTitle = '' }: CreatePostDialogProps) {
  const { user } = useAuth();
  const { openModal } = useAuthModal();
  // Guard: if rendered without an authenticated user, close the dialog and
  // open the sign-in modal. MOVED INTO useEffect — calling onClose /
  // openModal during render violates React's render-must-be-pure rule and
  // causes infinite loops in StrictMode (H11 in audit-findings.md).
  // The `eslint-disable` is intentional: we only want to fire this once
  // when `user` flips from non-null to null, not on every render.
  useEffect(() => {
    if (!user) {
      onClose();
      openModal('signin');
    }
  }, [user]);
  if (!user) return null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const DRAFT_KEY = 'yaksha_post_draft';
  const { currentBatch } = useBatch();
  const { data: categoriesData } = useCategories(currentBatch?._id ?? null, null);
  const categories = categoriesData?.categories.map(c => c.name) ?? [];

  // ── GCS attachments ──
  const { upload: uploadAttachment, uploading: attaching, error: attachmentError } = useGcsUpload('posts');
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<GcsAsset[]>([]);
  const MAX_ATTACHMENTS = 4;
  const handlePickAttachment = () => attachmentInputRef.current?.click();
  const handleAttachmentFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      try {
        const asset = await uploadAttachment(file);
        setAttachments((prev) => [...prev, asset].slice(0, MAX_ATTACHMENTS));
      } catch {
        // Error already set on the hook; just stop this batch.
        break;
      }
    }
  };
  const removeAttachment = (objectPath: string) => {
    setAttachments((prev) => prev.filter((a) => a.objectPath !== objectPath));
  };

  // Restore draft from sessionStorage on mount
  const [title, setTitle] = useState(() => {
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        const { t } = JSON.parse(draft);
        return t || prefillTitle || '';
      }
    } catch { void 0 }
    return prefillTitle || '';
  });
  const [body, setBody] = useState(() => {
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        const { b } = JSON.parse(draft);
        return b || '';
      }
    } catch { void 0 }
    return '';
  });
  const [loading, setLoading] = useState(false);
  // Synchronous re-entry guard. The button's `disabled` prop already
  // prevents the second click once React re-renders, but between the
  // first click and the next render there's a small window where a fast
  // double-click (or a screen-reader user hitting Enter twice) gets
  // through. The ref updates synchronously, so the second call returns
  // immediately without firing a duplicate POST. Reset in the finally
  // block so the dialog can be reopened for a different post.
  const submittingRef = useRef(false);
  const [error, setError] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [categoryOption, setCategoryOption] = useState<string>('');
  const [customCategory, setCustomCategory] = useState<string>('');
  const [duplicateMatch, setDuplicateMatch] = useState<{ isDuplicate: boolean; matches: DuplicateMatch[] } | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [floatAway] = useState(false);
  const duplicateCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Toast state
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' | 'info' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'warn' | 'info' = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Save draft on field changes
  const handleTitleChange = (val: string) => {
    setTitle(val);
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ t: val, b: body })); } catch { void 0 }
  };
  const handleBodyChange = (val: string) => {
    setBody(val);
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ t: title, b: val })); } catch { void 0 }
  };

  const handleDeflected = async (match: DuplicateMatch) => {
    try {
      await api.post('/community/resolve-deflection', {
        matchId: match._id,
        matchType: match.source,
        title: title.trim(),
      });
    } catch { void 0 }
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { void 0 }
    showToast('🎉 Glad we could help! You saved time and avoided a duplicate question.', 'success');
    dialogRef.current?.close();
  };


  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const handleBackdropClick = (e: MouseEvent) => {
        if (e.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isContent =
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
          rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
        if (!isContent) dialog.close();
      };
      dialog.addEventListener('click', handleBackdropClick);
      return () => {
        dialog.removeEventListener('close', handleClose);
        dialog.removeEventListener('click', handleBackdropClick);
      };
    }
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  useEffect(() => {
    if (duplicateCheckTimerRef.current) clearTimeout(duplicateCheckTimerRef.current);
    const q = title.trim();
    if (q.length < 10) {
      setDuplicateMatch(null);
      setCheckingDuplicates(false);
      return;
    }
    setCheckingDuplicates(true);
    duplicateCheckTimerRef.current = setTimeout(async () => {
      try {
        const res = await api.post<{ isDuplicate: boolean; matches: DuplicateMatch[] }>('/community/check-duplicate', { query: q });
        setDuplicateMatch(res.data);
      } catch {
        setDuplicateMatch(null);
      } finally {
        setCheckingDuplicates(false);
      }
    }, 600);
    return () => { if (duplicateCheckTimerRef.current) clearTimeout(duplicateCheckTimerRef.current); };
  }, [title]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    if (!title.trim() || !body.trim()) {
      setError('Both title and description are required.');
      return;
    }
    if (tags.length === 0) {
      setError('Please select or specify a category.');
      return;
    }
    // Block only if match is a high-confidence FAQ match (score >= 0.85).
    // Low-confidence / tangential matches are shown as suggestions — posting is allowed.
    const highConfidenceFaqMatch = duplicateMatch?.matches?.find(
      (m: DuplicateMatch) => m.source === 'faq' && m.score >= 0.85
    );
    if (highConfidenceFaqMatch) {
      setError('This question is already answered in our FAQ. Please check the FAQ page first.');
      return;
    }
    setLoading(true);
    try {
      // Per-form-mount idempotency key. Combined with the in-handler
      // submittingRef guard, this catches (a) fast double-clicks within
      // the React-render-lag window, and (b) network retries (mobile
      // drop / VPN reconnect). The backend's `Idempotency-Key` header
      // handler returns the same response for the same key within 60s.
      // Random UUID per form mount — re-mounting the dialog gets a new
      // key, which is what we want.
      const idempotencyKey = crypto.randomUUID();
      const res = await api.post<{ post: Post }>(
        '/community',
        {
          title: title.trim(),
          body: body.trim(),
          tags,
          // Send only the persisted fields the backend expects. The full
          // Cloudinary response has more (eager, etc.) that we don't save.
          attachments: attachments.map((a) => ({
            url: a.url,
            gcsUri: a.gcsUri,
            objectPath: a.objectPath,
            width: a.width,
            height: a.height,
            format: a.format,
            bytes: a.bytes,
          })),
        },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      // Clear draft on success
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { void 0 }
      // Show toast with duplicate check result
      const dupCount = duplicateMatch?.matches?.length ?? 0;
      if (dupCount > 0) {
        const faqMatches = duplicateMatch?.matches?.filter((m: DuplicateMatch) => m.source === 'faq').length ?? 0;
        if (faqMatches > 0) {
          showToast(`⚠️ Similar FAQ found — your question has been linked.`, 'warn');
        } else {
          showToast(`🔍 ${dupCount} similar discussion${dupCount > 1 ? 's' : ''} found — good to cross-reference.`, 'info');
        }
      } else {
        showToast(`✅ Your question has been posted to the community!`, 'success');
      }
      const dupResult = { isDuplicate: duplicateMatch?.isDuplicate ?? false, dupCount, faqMatches: duplicateMatch?.matches?.filter((m: DuplicateMatch) => m.source === 'faq').length ?? 0 };
      onCreated(res.data.post, dupResult);
      dialogRef.current?.close();
    } catch (err) {
      setError(friendlyError(err, 'Failed to post. Please try again.'));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  // Only block submission for high-confidence FAQ matches (score >= 0.85).
  // Low-confidence matches are informational only — posting is always allowed.
  const hasHighConfidenceFaqMatch = duplicateMatch?.matches?.some(
    (m: any) => m.source === 'faq' && m.score >= 0.85
  );
  // v1.65.1 — BUGFIX: the "Post Question" button must be disabled
  // while a Cloudinary upload is in flight. Without this, a user
  // can pick a file and click Post before the await in
  // handleAttachmentFile resolves + setAttachments fires + React
  // re-renders. The submit handler's `attachments` closure still
  // reads [] at that moment, so the post gets created with no
  // attachments and the image never references the (already
  // uploaded) Cloudinary asset. Symptom: post is created, image
  // is on Cloudinary, post body in the feed has no thumbnail.
  // The "+" pick-file button is already disabled while attaching
  // (so the user can see the spinner), but the submit button was
  // not — this commit closes that gap.
  const isSubmitDisabled =
    !title.trim() ||
    !body.trim() ||
    tags.length === 0 ||
    hasHighConfidenceFaqMatch ||
    checkingDuplicates ||
    loading ||
    attaching;

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="create-post-title"
      className={`m-auto w-full max-w-lg rounded-2xl border border-border shadow-2xl bg-card p-0 backdrop:bg-ink/30 backdrop:backdrop-blur-sm transition-all duration-300${floatAway ? " opacity-60 scale-[0.98]" : ""}`}
    >
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 id="create-post-title" className="text-base font-semibold text-ink">Ask a Question</h2>
            <p className="text-xs text-ink-soft mt-0.5">Share your question with the community</p>
          </div>
          <button
            onClick={() => dialogRef.current?.close()}
            aria-label="Close dialog"
            className="w-8 h-8 rounded-full bg-mist flex items-center justify-center text-ink-soft hover:text-ink hover:bg-border transition-all"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className={`space-y-4${floatAway ? ' animate-float-away' : ''}`}>
          <div>
            <label htmlFor="post-title" className="block text-xs font-medium text-ink-soft mb-1.5">
              Title <span className="text-danger">*</span>
            </label>
            <input
              id="post-title"
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="E.g. How do I request leave during the internship?"
              maxLength={150}
              required
              className="w-full rounded-xl border border-border bg-mist px-3 py-2.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:bg-card transition-all"
            />
            <div className="flex items-center justify-between mt-1">
              <div>
                {checkingDuplicates && (
                  <span className="text-xs text-ink-faint flex items-center gap-1">
                    <span className="w-3 h-3 border border-accent/30 border-t-accent rounded-full animate-spin inline-block" />
                    Checking duplicates...
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-faint text-right">{title.length}/150</p>
            </div>
          </div>

          <QuestionDeflectionOverlay
            matches={(duplicateMatch?.matches as DuplicateMatch[]) ?? []}
            queryTitle={title}
            onDeflected={handleDeflected}
            checking={checkingDuplicates}
          />


          {duplicateMatch && duplicateMatch.isDuplicate && duplicateMatch.matches.length > 0 && (
            <div className="faq-match-banner">
              <div className="flex items-center gap-1.5 mb-2">
                <span>📖</span>
                <p className="font-medium text-sm">Similar question found!</p>
                <span className="ml-auto text-[10px] text-ink-faint">Click to view</span>
              </div>
              <div className="space-y-1">
                {duplicateMatch.matches.slice(0, 3).map((m: any, i: number) => {
                  // Decide where to send the user
                  const href = m.source === 'faq'
                    ? `/faq/${m._id}`
                    : m.source === 'community'
                      ? `/community?post=${m._id}`
                      : `/faq/${m._id}`;
                  const icon = m.source === 'faq' ? '📋' : m.source === 'community' ? '💬' : '🧠';
                  const label = m.source === 'faq' ? 'FAQ' : m.source === 'community' ? 'Community' : 'Knowledge';
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        // Close dialog and navigate to the existing item
                        dialogRef.current?.close();
                        navigate(href);
                      }}
                      className={communityTemplateCard}
                    >
                      <span className="shrink-0 mt-0.5">{icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={communityTemplateLabel}>{label}</span>
                          {m.score && (
                            <span className="text-[10px] text-ink-faint">{(m.score * 100).toFixed(0)}% match</span>
                          )}
                        </div>
                        <p className="text-xs text-ink-soft group-hover:text-ink line-clamp-1">
                          "{m.question || m.title}"
                        </p>
                      </div>
                      <svg className={communityTemplateIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18l6-6-6-6"/>
                      </svg>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="post-body" className="block text-xs font-medium text-ink-soft mb-1.5">
              Description <span className="text-danger">*</span>
            </label>
            <textarea
              id="post-body"
              value={body}
              onChange={(e) => handleBodyChange(e.target.value)}
              rows={5}
              placeholder="Describe your question in detail. Include any context that might be helpful…"
              maxLength={2000}
              required
              className="w-full rounded-xl border border-border bg-mist px-3 py-2.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:bg-card transition-all resize-none"
            />
            <p className={`text-xs mt-1 text-right ${body.length > 1800 ? 'text-danger font-semibold' : 'text-ink-faint'}`}>{body.length}/2000</p>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1.5">
              Category <span className="text-danger">*</span>
            </label>
            <CategoryDropdown
              value={categoryOption}
              categories={categories}
              onChange={val => {
                setCategoryOption(val);
                if (val !== '__other__') {
                  setTags(val ? [val] : []);
                  setCustomCategory('');
                } else {
                  setTags([]);
                }
              }}
              placeholder="Select a category"
            />
            {categoryOption === '__other__' && (
              <input
                type="text"
                value={customCategory}
                onChange={e => {
                  setCustomCategory(e.target.value);
                  setTags(e.target.value.trim() ? [e.target.value.trim()] : []);
                }}
                placeholder="Enter custom category..."
                className="w-full mt-2 rounded-xl border border-border bg-mist px-3 py-2.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/25 focus:bg-card transition-all"
              />
            )}
          </div>

          {/* Attachments */}
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1.5">
              Attachments <span className="text-ink-faint font-normal">(optional — up to {MAX_ATTACHMENTS} images)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div key={a.objectPath} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border bg-mist group">
                  <img
                    src={buildGcsTransformedUrl(a.url, 'w_120,h_120,c_fill,q_auto,f_auto')}
                    alt="attachment preview"
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.objectPath)}
                    aria-label="Remove attachment"
                    className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-ink/70 text-accent-text text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
              {attachments.length < MAX_ATTACHMENTS && (
                <button
                  type="button"
                  onClick={handlePickAttachment}
                  disabled={attaching}
                  className="w-16 h-16 rounded-lg border border-dashed border-border bg-mist flex flex-col items-center justify-center text-ink-faint hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-50"
                >
                  {attaching ? (
                    <span className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <path d="M21 15l-5-5L5 21"/>
                      </svg>
                      <span className="text-[9px] font-semibold mt-0.5">Add</span>
                    </>
                  )}
                </button>
              )}
              <input
                ref={attachmentInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                onChange={handleAttachmentFile}
                className="hidden"
              />
            </div>
            {attachmentError && (
              <p className="text-xs text-danger mt-1">{attachmentError}</p>
            )}
          </div>

          {error && (
            <p className="text-xs text-danger bg-danger-light border border-danger/15 rounded-xl px-3 py-2">{error}</p>
          )}

          {toast && (
            <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-float border animate-fade-in
              ${toast.type === 'success' ? 'bg-accent/10 border-accent/30 text-accent' :
                toast.type === 'warn' ? communityToastWarn :
                'bg-accent/10 border-accent/30 text-accent'}`}>
              {toast.msg}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              loading={loading}
              disabled={isSubmitDisabled}
              className="flex-1"
            >
              Post Question
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
