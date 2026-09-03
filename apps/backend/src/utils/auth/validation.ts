/**
 * Centralised request validation schemas using Zod.
 * Import the schemas you need in controllers and call .parse() early.
 * Zod throws ZodError on failure — catch it in your controller and return 400.
 */
import { z } from 'zod';
import type { Response } from 'express';

// ─── Auth ───────────────────────────────────────────────────────────────────────
// Password policy (OWASP A07 / NIST 800-63B aligned): minimum length 8,
// capped at 128 to bound bcrypt work, and must mix letters + digits so that
// trivial passwords ("password", "111111") are rejected at the boundary.
// NOTE: `loginSchema` deliberately keeps `min(1)` — tightening login would
// lock out existing accounts created under the old 6-char rule. The stronger
// policy applies only at registration and password-change time.
export const passwordPolicy = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

export const registerSchema = z.object({
  name:     z.string().min(2, 'Name must be at least 2 characters').max(100),
  email:    z.string().email('Invalid email address'),
  password: passwordPolicy,
});

export const loginSchema = z.object({
  email:    z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword:     passwordPolicy,
});

// v1.85 — admin-initiated password reset for any non-admin user.
// Body is just the new password (no currentPassword — admin
// doesn't know it). Reuses the same passwordPolicy as the
// user-self-change path so the bar is consistent.
export const adminResetPasswordSchema = z.object({
  newPassword: passwordPolicy,
});

export const updateProfileSchema = z.object({
  name:  z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  guidedTourCompleted: z.boolean().optional(),
  // v1.87 — Sign My Tee. Accepts either an ISO 8601 string
  // (`2026-07-14T00:00:00.000Z`) from JSON callers OR a
  // date-only `YYYY-MM-DD` shape from the FE's `<input type="date">`
  // (which never emits time components). We normalise to a Date,
  // anchored to UTC midnight for the date-only variant, so the
  // canonical storage value is timezone-agnostic. Setting `null`
  // clears the date (e.g. if an admin ever needs to reset it).
  internshipEndDate: z
    .union([
      z.string().datetime({ offset: true }),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    ])
    .transform((v) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
      return new Date(v);
    })
    .nullable()
    .optional(),
  avatar: z
    .object({
      url: z.string().url().max(1000),
      publicId: z.string().max(200).optional(),
      gcsUri: z.string().max(1000).optional(),
      objectPath: z.string().max(1000).optional(),
    })
    .nullable()
    .optional(),
});

// ─── FAQ ────────────────────────────────────────────────────────────────────────
const objectIdLike = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId');

export const createFAQSchema = z.object({
  question:           z.string().min(3, 'Question is too short').max(500),
  answer:             z.string().min(3, 'Answer is too short').max(10000),
  category:           z.string().min(1, 'Category is required').max(100),
  batchId:            objectIdLike,
  freshnessTier:      z.enum(['evergreen', 'seasonal', 'volatile']).optional(),
  reviewIntervalDays: z.number().int().min(0).max(365).optional(),
});

export const updateFAQSchema = z.object({
  question:           z.string().min(3).max(500).optional(),
  answer:             z.string().min(3).max(10000).optional(),
  category:           z.string().min(1).max(100).optional(),
  batchId:            objectIdLike.optional(),
  status:             z.enum(['approved', 'pending', 'rejected']).optional(),
  freshnessTier:      z.enum(['evergreen', 'seasonal', 'volatile']).optional(),
  reviewIntervalDays: z.number().int().min(0).max(365).optional(),
});

export const flagFAQSchema = z.object({
  reason: z.string().max(200, 'Reason must be 200 characters or less').optional(),
});

export const voteReviewSchema = z.object({
  verdict:     z.enum(['still_accurate', 'needs_update']),
  suggestion:  z.string().max(300, 'Suggestion must be 300 characters or less').optional(),
});

// ─── Community ──────────────────────────────────────────────────────────────────
export const createPostSchema = z.object({
  title: z.string().min(10, 'Title must be at least 10 characters').max(300),
  body:  z.string().min(20, 'Body must be at least 20 characters').max(5000),
  tags:  z.array(z.string()).min(1, 'At least one category tag is required').max(3),
  attachments: z.array(
    z.object({
      url: z.string(),
      publicId: z.string().optional(),
      gcsUri: z.string().optional(),
      objectPath: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      format: z.string().optional(),
      bytes: z.number().optional(),
    })
  ).optional(),
});

export const checkDuplicateSchema = z.object({
  query:      z.string().min(3),
  isShortQuery: z.boolean().optional(),
});

export const addCommentSchema = z.object({
  body:     z.string().min(1).max(1000),
  parentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid parentId').optional(),
});

export const resolvePostSchema = z.object({
  answer: z.string().min(10).max(5000),
});

export const reportPostSchema = z.object({
  reason: z.string().min(3).max(300),
});

// H4-2 (HIGH) fix: refresh token Zod schema. The previous
// `refresh` controller read `req.body.refreshToken` raw — a 10MB
// string would hit `jwt.verify` and exhaust memory. Bound it
// between min 20 chars (longest reasonable JWT) and max 2048 chars
// (plenty for a JWT + a few bytes of padding). The controller
// already handles the `refreshToken: undefined` case (returns 400
// 'Refresh token is required') so a missing field doesn't need a
// separate Zod error.
export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(2048),
});

// ─── Search ─────────────────────────────────────────────────────────────────────
// v1.79.1 (HOTFIX) — schema renamed `q` → `query` so it matches the
// shape the frontend POSTs (`SearchBar.tsx`, `InteractiveSearchOverlay.tsx`).
// Previously every request returned 400 with `{ field: 'q', message: 'Required' }`
// even though the body contained `query`. The `limit`/`page`/`source` fields
// are dropped because the controller doesn't use them — keeping them
// required-as-defaults would silently bind the controller to unused knobs.
export const searchSchema = z.object({
  query: z.string().min(1).max(200),
  batchId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  threshold: z.union([z.number(), z.string()]).optional(),
});

// v1.79.1 (HOTFIX) — `feedback` was being POSTed by `SearchFeedback.tsx`
// but the schema didn't declare it, so Zod's `.object()` rejected the
// unknown key → 400. Added as optional to match the controller's read.
export const submitUnresolvedSchema = z.object({
  query:    z.string().min(1).max(500),
  faqId:    z.string().regex(/^[0-9a-fA-F]{24}$/).nullish(),
  feedback: z.string().max(2000).optional(),
});

export const resolveUnresolvedSchema = z.object({
  resolution: z.enum(['faq_updated', 'community_post_created', 'dismissed']),
});

// ─── Moderation ────────────────────────────────────────────────────────────────
export const warnUserSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  reason: z.string().min(3).max(500),
});

export const suspendUserSchema = z.object({
  userId:   z.string().regex(/^[0-9a-fA-F]{24}$/),
  // 5.1 fix: the controller reads `duration` as a string like `"24h"` or `"7d"`,
  // not a `days: number`. We accept BOTH for backward compat — `days` is
  // still honored by the controller (converted internally to `${days}d`),
  // but new callers should prefer `duration`.
  duration: z.string().regex(/^\d+(h|d)$/).optional(),
  days:     z.coerce.number().int().min(1).max(365).optional(),
  reason:   z.string().min(3).max(500),
}).refine(
  (data) => data.duration !== undefined || data.days !== undefined,
  { message: 'Either duration (e.g. "24h", "7d") or days (1-365) is required.' },
);

export const banUserSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  reason: z.string().min(3).max(500),
});

export const softDeleteSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/),
});

// ─── Reputation ────────────────────────────────────────────────────────────────
export const awardPointsSchema = z.object({
  userId:   z.string().regex(/^[0-9a-fA-F]{24}$/),
  delta:    z.number().int().min(-1000).max(1000),
  reason:   z.string().max(200).optional(),
});

export const issueBadgeSchema = z.object({
  userId:   z.string().regex(/^[0-9a-fA-F]{24}$/),
  badgeId:  z.string().regex(/^[0-9a-fA-F]{24}$/),
  reason:   z.string().max(200).optional(),
});

// ─── Helper ─────────────────────────────────────────────────────────────────────
/**
 * Parse a Zod schema and return 400 JSON response on failure.
 * Usage in controller:
 *   const body = await validate(req.body, createPostSchema, res);
 *   if (!body) return; // response already sent
 */
export async function validate<T extends z.ZodTypeAny>(
  data: unknown,
  schema: T,
  res: Response
): Promise<z.infer<T> | null> {
  try {
    return await schema.parseAsync(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        message: 'Validation error',
        errors: (err as z.ZodError).issues.map((e: z.ZodIssue) => ({ field: e.path.join('.'), message: e.message })),
      });
    } else {
      res.status(500).json({ message: 'Validation error' });
    }
    return null;
  }
}

// ─── Express middleware factory ─────────────────────────────────────────────────

import type { Request, RequestHandler } from 'express';

/**
 * Creates an Express middleware that validates req.body against a Zod schema.
 * Returns 400 with detailed errors on failure; passes to next() on success.
 *
 * Usage:
 *   router.post('/register', registerLimiter, validateBody(registerSchema), register);
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T): RequestHandler {
  return (req: Request, res: Response, next) => {
    schema
      .parseAsync(req.body)
      .then((body) => { req.body = body; next(); })
      .catch((err) => {
        if (err instanceof z.ZodError) {
          res.status(400).json({
            message: 'Validation error',
            errors: err.issues.map((e: z.ZodIssue) => ({ field: e.path.join('.'), message: e.message })),
          });
        } else {
          res.status(500).json({ message: 'Validation error' });
        }
      });
  };
}