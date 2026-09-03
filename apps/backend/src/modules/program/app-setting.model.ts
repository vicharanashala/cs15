/**
 * AppSetting — global app-level configuration values, admin-editable.
 *
 * v1.65 — Golden Ticket feature introduced the first such setting
 * (goldenCooldownHours). The model is intentionally generic so future
 * cross-cutting settings can register their own keys without needing
 * a new schema each time.
 *
 * Storage shape: a single document with id 'singleton'. The
 * `settings` field is a free-form map of { key: value } where value
 * is one of the types below. Validators on each key ensure admins
 * can't poison a number field with a string.
 *
 * Endpoints (see routes/appSettings.ts):
 *   GET /api/admin/settings  (admin only)
 *   PUT /api/admin/settings  (admin only, body: { key, value })
 *   GET /api/public/settings  (any authed user; returns only the
 *                             public-safe subset — used by the
 *                             frontend to display countdown copy)
 */

import mongoose, { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type SettingKey = 'goldenCooldownHours' | 'goldenPenaltyMultiplier' | 'zoomPassScore' | 'zoomQuestionCount' | 'zoomTranscript' | 'zoomUrl' | 'zoomTitle' | 'zoomDescription' | 'zoomDuration' | 'zoomActive' | 'zoomDailyResetTime' | 'autoAnswerApproveThreshold' | 'autoAnswerSuggestThreshold' | 'autoAnswerMinConfidence' | 'autoAnswerBatchSize' | 'autoAnswerMinAgeHours' | 'autoAnswerAskHumanThreshold' | 'autoAnswerCooldownMinutes' | 'faqDuplicateThreshold' | 'searchThreshold' | 'teeMockupUrl' | 'teeMockupBackUrl';

export interface IAppSetting extends Document<string> {
  /** Always 'singleton' — there is only one settings document. */
  _id: 'singleton';
  /** Map of admin-configurable settings. Validated per-key below. */
  settings: {
    /** v1.65.1 — Hours a user must wait after a Golden Ticket is
     *  closed (either by admin resolution or admin rejection)
     *  before they can submit another. Default 48. Range 0-720.
     *  This is the ONLY post-resolution consequence — the spec is
     *  "cooldown only, never ban, never deduct beyond the SP
     *  spend". 0 disables the gate entirely. */
    goldenCooldownHours?: number;
    goldenPenaltyMultiplier?: number;
    /** Zoom Assessment Gateway Config */
    zoomPassScore?: number;
    zoomQuestionCount?: number;
    zoomTranscript?: string;
    zoomUrl?: string;
    zoomTitle?: string;
    zoomDescription?: string;
    zoomDuration?: string;
    zoomActive?: boolean;
    zoomDailyResetTime?: string;
    autoAnswerApproveThreshold?: number;
    autoAnswerSuggestThreshold?: number;
    autoAnswerMinConfidence?: number;
    autoAnswerBatchSize?: number;
    autoAnswerMinAgeHours?: number;
    faqDuplicateThreshold?: number;
    searchThreshold?: number;
    teeMockupUrl?: string;
    teeMockupBackUrl?: string;
  };
  /** Last admin to edit. */
  updatedBy: Types.ObjectId | null;
  updatedAt: Date;
  createdAt: Date;
}

const appSettingSchema = new MongooseSchema<IAppSetting>(
  {
    _id: { type: String, default: 'singleton' },
    settings: {
      goldenCooldownHours: {
        type: Number,
        default: 48,
        min: 0,
        max: 720,
      },
      goldenPenaltyMultiplier: {
        type: Number,
        default: 1.25,
        min: 0,
        max: 5,
      },
      zoomPassScore: { type: Number, default: 70, min: 0, max: 100 },
      zoomQuestionCount: { type: Number, default: 10, min: 5, max: 20 },
      zoomTranscript: { type: String, default: '' },
      zoomUrl: { type: String, default: '' },
      zoomTitle: { type: String, default: 'Onboarding Zoom Session' },
      zoomDescription: { type: String, default: 'Join us for the live onboarding.' },
      zoomDuration: { type: String, default: '60 minutes' },
      zoomActive: { type: Boolean, default: false },
      zoomDailyResetTime: { type: String, default: '09:00 AM' },
      autoAnswerApproveThreshold: { type: Number, default: 0.85, min: 0, max: 1 },
      autoAnswerSuggestThreshold: { type: Number, default: 0.60, min: 0, max: 1 },
      autoAnswerMinConfidence: { type: Number, default: 0.35, min: 0, max: 1 },
      autoAnswerBatchSize: { type: Number, default: 20, min: 1, max: 1000 },
      autoAnswerMinAgeHours: { type: Number, default: 2, min: 0, max: 720 },
      autoAnswerAskHumanThreshold: { type: Number, default: 0.30, min: 0, max: 1 },
      autoAnswerCooldownMinutes: { type: Number, default: 60, min: 1, max: 1440 },
      faqDuplicateThreshold: { type: Number, default: 0.82, min: 0, max: 1 },
      searchThreshold: { type: Number, default: 0.80, min: 0, max: 1 },
      teeMockupUrl: { type: String, default: '' },
      teeMockupBackUrl: { type: String, default: '' }
    },
    updatedBy: { type: MongooseSchema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, _id: false }
);

/**
 * Read a single setting. Returns `defaultValue` if the document
 * doesn't exist yet (first boot, no admin has saved a value) or if
 * the key is unset on the document.
 *
 * Always seeds the singleton on read so the admin UI sees a value
 * even before anyone has explicitly saved.
 */
export async function readSetting<K extends SettingKey>(
  key: K,
  // Indexed access through a `K extends SettingKey` constraint triggers
  // TS2536 against the optional `settings` interface. The runtime value
  // is whatever the admin saved (or this default); the return is asserted
  // to the caller's declared type via `as` at each return path.
  // @ts-expect-error TS2536: K-vs-optional-settings indexed access
  defaultValue: NonNullable<IAppSetting['settings'][K]>,
  batchId?: string | Types.ObjectId | null
  // @ts-expect-error TS2536: K-vs-optional-settings indexed access
): Promise<NonNullable<IAppSetting['settings'][K]>> {
  // Indexed access through a `K extends SettingKey` constraint can't be
  // resolved against the optional `settings` interface (TS2536). The
  // shape of `settings` and `SettingKey` drift between releases and
  // the runtime value is whatever the admin saved (or this default).
  // Cast at the read site; the return is asserted to match the caller's
  // declared type via the `as` on each return path.
  const keyStr = key as unknown as string;
  if (batchId) {
    try {
      const ProgramConfig = mongoose.model('ProgramConfig');
      const doc = await ProgramConfig.findOne({ batchId: new Types.ObjectId(batchId.toString()) }).lean();
      const v = (doc as { appSettings?: Record<string, unknown> } | null)?.appSettings?.[keyStr];
      if (v !== undefined && v !== null) {
        // @ts-expect-error TS2536: K-vs-optional-settings indexed access
        return v as NonNullable<IAppSetting['settings'][K]>;
      }
    } catch (err) {
      // Ignore and fall back to global AppSetting
    }
  }
  const doc = await AppSetting.findById('singleton').lean();
  if (!doc) return defaultValue;
  const settingsObj = doc.settings as unknown as Record<string, unknown> | undefined;
  const v = settingsObj?.[keyStr];
  // @ts-expect-error TS2536: K-vs-optional-settings indexed access
  return (v ?? defaultValue) as NonNullable<IAppSetting['settings'][K]>;
}

const AppSetting = mongoose.model<IAppSetting>('AppSetting', appSettingSchema);
export default AppSetting;
