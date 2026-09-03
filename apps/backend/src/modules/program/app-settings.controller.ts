/**
 * appSettingsController.ts — admin-editable global app settings.
 *
 * v1.65 — Golden Ticket feature introduced `goldenCooldownHours`
 * (default 48) and `goldenPenaltyMultiplier` (default 1.25). Both
 * are stored in the singleton AppSetting document and read by
 * `supportCore.ts` helpers at request time.
 *
 * Endpoints:
 *   GET  /api/admin/settings    (admin only — full settings)
 *   PUT  /api/admin/settings    (admin only — body: { key, value })
 *   GET  /api/public/settings   (any authed user — public-safe copy)
 *
 * The public endpoint exposes only the values the frontend needs to
 * render UI (cooldown hours, so it can compute "next available" copy
 * without round-tripping). SP penalty math stays server-side.
 */

import { Request, Response } from 'express';
import { Types } from 'mongoose';
import AppSetting, { readSetting, type SettingKey } from './app-setting.model.js';
// v1.69 — Phase 9: per-program app settings (Golden Ticket
// cooldown, SP cost, penalty multiplier) live in
// ProgramConfig.appSettings. The resolver walks per-program
// first, falling back to the global AppSetting.
import { getProgramAppSettings, invalidateProgramAppSettingsCache } from '../../utils/program/appSettings.js';
import { getAuthedUserId } from '../support/support-core.controller.js';
import { adminLog } from '../../utils/http/logger.js';

/** Public-safe subset returned to non-admin callers. */
const PUBLIC_KEYS: SettingKey[] = ['goldenCooldownHours', 'teeMockupUrl', 'teeMockupBackUrl'];

function batchIdFromQueryOrBody(req: Request): string | null {
  const q = req.query.batchId;
  if (typeof q === 'string' && q.length > 0) return q;
  const b = (req.body as { batchId?: string } | undefined)?.batchId;
  if (typeof b === 'string' && b.length > 0) return b;
  return null;
}

function adminOnly(req: Request, res: Response): { userId: Types.ObjectId } | null {
  const userId = getAuthedUserId(req);
  if (!userId) { res.status(401).json({ message: 'Authentication required.' }); return null; }
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  if (role !== 'admin' && role !== 'moderator') {
    res.status(403).json({ message: 'Admin only.' });
    return null;
  }
  return { userId };
}

/**
 * GET /api/admin/settings
 * v1.69 — Phase 9: per-program scoped. When ?batchId=... is
 * supplied, the response is the per-program override merged
 * with the global AppSetting defaults. When null, returns the
 * global singleton.
 */
export async function adminGetSettings(req: Request, res: Response): Promise<void> {
  try {
    const batchIdRaw = batchIdFromQueryOrBody(req);
    if (batchIdRaw) {
      if (!Types.ObjectId.isValid(batchIdRaw)) {
        res.status(400).json({ message: 'Invalid batchId.' });
        return;
      }
      const settings = await getProgramAppSettings(batchIdRaw);
      res.json({ settings, batchId: batchIdRaw, source: 'program-or-global' });
      return;
    }
    let doc = await AppSetting.findById('singleton').lean();
    if (!doc) {
      // First-time seed — let the schema defaults populate the doc.
      await AppSetting.create({ _id: 'singleton' });
      doc = await AppSetting.findById('singleton').lean();
    }
    res.json({ settings: doc?.settings ?? {}, source: 'global' });
  } catch (err) {
    adminLog.error(`[appSettings] adminGetSettings failed: ${(err as Error).message}`);
    res.status(500).json({ message: 'Failed to load settings.' });
  }
}

/**
 * PUT /api/admin/settings
 * Body: { key: SettingKey, value: number | string | boolean }
 * Validates the value against the schema-level min/max for known
 * keys. Unknown keys are accepted but stored as-is (so the model
 * stays forward-compatible with new settings).
 */
export async function adminUpdateSetting(req: Request, res: Response): Promise<void> {
  const auth = adminOnly(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as { key?: string; value?: unknown };
  const key = String(body.key ?? '').trim() as SettingKey;
  if (!key) {
    res.status(400).json({ message: 'key is required.' });
    return;
  }
  // Schema-level validation lives on the model, but we mirror it here
  // for friendlier 400s on common cases.
  if (key === 'goldenCooldownHours') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || n > 720 || !Number.isInteger(n)) {
      res.status(400).json({ message: 'goldenCooldownHours must be an integer between 0 and 720.' });
      return;
    }
  } else if (key === 'goldenPenaltyMultiplier') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      res.status(400).json({ message: 'goldenPenaltyMultiplier must be a number between 0 and 5.' });
      return;
    }
  } else if (key === 'teeMockupUrl' || key === 'teeMockupBackUrl') {
    if (typeof body.value !== 'string') {
      res.status(400).json({ message: `${key} must be a string.` });
      return;
    }
  } else if (key === 'searchThreshold') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      res.status(400).json({ message: 'searchThreshold must be a number between 0 and 1.' });
      return;
    }
  } else {
    res.status(400).json({ message: `Unknown setting key: ${key}` });
    return;
  }

  try {
    const update: Record<string, unknown> = { updatedBy: auth.userId };
    update[`settings.${key}`] = body.value;
    const doc = await AppSetting.findByIdAndUpdate(
      'singleton',
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ settings: doc?.settings ?? {} });
  } catch (err) {
    adminLog.error(`[appSettings] adminUpdateSetting failed: ${(err as Error).message}`);
    res.status(500).json({ message: 'Failed to update setting.' });
  }
}

/**
 * v1.69 — Phase 9: per-program app setting upsert.
 * PUT /api/admin/programs/:id/settings  body: { key, value }
 * Stores a per-program override in ProgramConfig.appSettings.
 * The next getProgramAppSettings(batchId) call returns the
 * override; missing keys fall through to the global AppSetting.
 */
export async function adminUpdatePerProgramSetting(
  req: Request, res: Response
): Promise<void> {
  const auth = adminOnly(req, res);
  if (!auth) return;
  const rawBatch = req.params.batchId ?? req.params.id;
  const batchId = Array.isArray(rawBatch) ? rawBatch[0] : rawBatch;
  if (!batchId || !Types.ObjectId.isValid(batchId)) {
    res.status(400).json({ message: 'Valid batchId is required.' });
    return;
  }
  const body = (req.body ?? {}) as { key?: string; value?: unknown };
  const key = String(body.key ?? '').trim();
  if (!key) {
    res.status(400).json({ message: 'key is required.' });
    return;
  }
  // Mirror the global validation (goldenTicketCooldownHours
  // is the only key we strictly validate today; others are
  // pass-through so the schema stays forward-compatible).
  if (key === 'goldenTicketCooldownHours') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || n > 720 || !Number.isInteger(n)) {
      res.status(400).json({ message: 'goldenTicketCooldownHours must be an integer between 0 and 720.' });
      return;
    }
  } else if (key === 'penaltyMultiplier') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || n > 5) {
      res.status(400).json({ message: 'penaltyMultiplier must be a number between 0 and 5.' });
      return;
    }
  } else if (key === 'goldenTicketSpCost') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      res.status(400).json({ message: 'goldenTicketSpCost must be a non-negative integer.' });
      return;
    }
  }
  try {
    const { default: ProgramConfig } = await import('./program-config.model.js');
    const doc = await ProgramConfig.findOneAndUpdate(
      { batchId: new Types.ObjectId(batchId) },
      { $set: { [`appSettings.${key}`]: body.value } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    invalidateProgramAppSettingsCache(String(batchId));
    res.json({ ok: true, settings: (doc as { appSettings?: Record<string, unknown> } | null)?.appSettings ?? {} });
  } catch (err) {
    adminLog.error(`[appSettings] adminUpdatePerProgramSetting failed: ${(err as Error).message}`);
    res.status(500).json({ message: 'Failed to save per-program app setting.' });
  }
}

/**
 * GET /api/public/settings
 * v1.69 — Phase 9: per-program scoped. When ?batchId=... is
 * supplied, the resolver walks the per-program ProgramConfig
 * first, falling back to the global AppSetting singleton. The
 * public-safe subset is returned.
 */
export async function publicGetSettings(req: Request, res: Response): Promise<void> {
  try {
    const batchIdRaw = batchIdFromQueryOrBody(req);
    const out: Record<string, unknown> = {};
    for (const k of PUBLIC_KEYS) {
      if (k === 'goldenCooldownHours') {
        const fallback = await readSetting('goldenCooldownHours', 48);
        if (batchIdRaw && Types.ObjectId.isValid(batchIdRaw)) {
          const perProgram = await getProgramAppSettings(batchIdRaw);
          out[k] = perProgram.goldenCooldownHours ?? fallback;
        } else {
          out[k] = fallback;
        }
      } else if (k === 'teeMockupUrl') {
        const fallback = await readSetting('teeMockupUrl', '');
        out[k] = fallback;
      } else if (k === 'teeMockupBackUrl') {
        const fallback = await readSetting('teeMockupBackUrl', '');
        out[k] = fallback;
      }
    }
    res.json({ settings: out });
  } catch (err) {
    adminLog.error(`[appSettings] publicGetSettings failed: ${(err as Error).message}`);
    res.status(500).json({ message: 'Failed to load settings.' });
  }
}
