/**
 * ProgramConfig — v1.69
 *
 * Operational config for a program that was previously scattered
 * across `User` (Zoom OAuth tokens), `AppSetting` (Golden Ticket
 * cooldowns), and env vars. The intent is to let a single global
 * admin run multiple programs each with their own:
 *
 *   - Zoom OAuth connection (client + encrypted access/refresh)
 *   - Discord bot token + guild + webhook
 *   - Per-program app settings (Golden Ticket SP cost, cooldown)
 *
 * 1:1 with `Batch` via `batchId` (unique). The model is
 * intentionally narrow: anything user-facing (theme, hero copy,
 * sections, branding) lives in `ProgramSettings`. This file is
 * the per-program "ops backend" config.
 *
 * Secret fields (`zoom.accessToken`, `zoom.refreshToken`,
 * `zoom.clientSecret`, `discord.botToken`) must be AES-256-GCM
 * encrypted at rest. The encryption helpers live in `utils/crypto.ts`.
 */

import mongoose, { Document, Schema as MongooseSchema, Types } from 'mongoose';

export interface IZoomConfig {
  clientId?: string | null;
  /** AES-256-GCM ciphertext (base64). Use crypto.encryptSecret. */
  clientSecret?: string | null;
  redirectUri?: string | null;
  /** AES-256-GCM ciphertext. */
  webhookSecretToken?: string | null;
  connected: boolean;
  /** AES-256-GCM ciphertext. */
  accessToken?: string | null;
  /** AES-256-GCM ciphertext. */
  refreshToken?: string | null;
  tokenExpiry?: Date | null;
  connectedAt?: Date | null;
}

export interface IDiscordConfig {
  /** AES-256-GCM ciphertext. */
  botToken?: string | null;
  applicationId?: string | null;
  guildId?: string | null;
  /**
   * v1.69 — Phase 6: the bot pushes tea-drop notifications
   * (mentions, status changes) to this channel inside the
   * guild. Per-program so each program's bot posts to its
   * own notification channel rather than a global one.
   */
  notificationChannelId?: string | null;
  /** Plain URL (webhooks aren't secret-shaped like bot tokens). */
  webhookUrl?: string | null;
  enabled: boolean;
}

export interface IProgramAppSettings {
  goldenTicketCooldownHours: number;
  goldenTicketSpCost: number;
  penaltyMultiplier: number;
  autoAnswerApproveThreshold?: number;
  autoAnswerSuggestThreshold?: number;
  autoAnswerMinConfidence?: number;
  autoAnswerBatchSize?: number;
  autoAnswerMinAgeHours?: number;
  faqDuplicateThreshold?: number;
  searchThreshold?: number;
}

export interface IProgramConfig extends Document {
  batchId: Types.ObjectId;
  zoom: IZoomConfig;
  discord: IDiscordConfig;
  appSettings: IProgramAppSettings;
  createdAt: Date;
  updatedAt: Date;
}

const programConfigSchema = new MongooseSchema<IProgramConfig>(
  {
    // 1:1 with Batch. Unique so two programs can never collide.
    batchId: {
      type: MongooseSchema.Types.ObjectId,
      ref: 'Batch',
      required: true,
      unique: true,
      index: true,
    },
    zoom: {
      clientId:           { type: String, default: null },
      clientSecret:       { type: String, default: null },
      redirectUri:        { type: String, default: null },
      webhookSecretToken: { type: String, default: null },
      connected:          { type: Boolean, default: false },
      accessToken:        { type: String, default: null },
      refreshToken:       { type: String, default: null },
      tokenExpiry:        { type: Date,    default: null },
      connectedAt:        { type: Date,    default: null },
    },
    discord: {
      botToken:      { type: String, default: null },
      applicationId: { type: String, default: null },
      guildId:       { type: String, default: null },
      // v1.69 — Phase 6: per-program notification channel.
      notificationChannelId: { type: String, default: null },
      webhookUrl:    { type: String, default: null },
      enabled:       { type: Boolean, default: false },
    },
    appSettings: {
      goldenTicketCooldownHours: { type: Number, default: 48 },
      goldenTicketSpCost:         { type: Number, default: 50 },
      penaltyMultiplier:          { type: Number, default: 1 },
      autoAnswerApproveThreshold: { type: Number, default: null },
      autoAnswerSuggestThreshold: { type: Number, default: null },
      autoAnswerMinConfidence: { type: Number, default: null },
      autoAnswerBatchSize: { type: Number, default: null },
      autoAnswerMinAgeHours: { type: Number, default: null },
      faqDuplicateThreshold: { type: Number, default: null },
      searchThreshold: { type: Number, default: null }
    },
  },
  { timestamps: true }
);

export default mongoose.model<IProgramConfig>(
  'ProgramConfig',
  programConfigSchema,
  'yaksha_program_configs'
);
