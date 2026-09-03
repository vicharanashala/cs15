/**
 * runtimeConfig.ts — three-layer runtime config resolver.
 *
 * Resolution order for `getConfig(key, opts)`:
 *   1. Code default from Zod schema (lowest priority)
 *   2. process.env (middle priority) — uses keyToEnvVar() to convert
 *      dotted keys to SCREAMING_SNAKE_CASE
 *   3. AdminConfig Mongo override (highest priority)
 *      - Per-program override if opts.programId is given
 *      - Else global override (programId === null)
 *
 * In-memory cache (TTL 30s) prevents a hot read path from hammering
 * Mongo. Writes (via admin.config.service) invalidate the cache for
 * the affected key.
 *
 * NOT YET WIRED INTO THE REST OF THE APP. Phase 1 ships the resolver
 * + REST endpoints; consumers (auth.ts reading JWT_SECRET, ai/
 * services reading API keys) migrate incrementally. Until they do,
 * existing `process.env.X` reads keep working unchanged.
 */
import type { Types } from 'mongoose';
import AdminConfig from '../models/AdminConfig.js';
import { categorize, keyToEnvVar, parseEnvValue } from './adminCategorize.js';
import { loadConfig } from './loader.js';

export type ConfigSource = 'mongo' | 'env' | 'default';

export interface ConfigLookupResult {
  /** The resolved value, already typed (string, number, boolean, object, etc). */
  value: unknown;
  /** Which layer provided the value (for diagnostics + audit). */
  source: ConfigSource;
  /** True only when source === 'mongo' AND the row is stored encrypted. */
  isEncrypted: boolean;
  /** The key as stored (preserves the caller-supplied casing for the response). */
  key: string;
  /** Category for UI grouping. */
  category: string;
  /** Scope the value came from. */
  scope: 'global' | 'program';
  /** Mongo _id when source === 'mongo'. */
  mongoId?: string;
}

export interface RuntimeConfigOptions {
  /** When set, look up per-program override first, falling back to global. */
  programId?: Types.ObjectId | string | null;
  /** Skip the in-memory cache (used by the write path to read fresh). */
  skipCache?: boolean;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: ConfigLookupResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(key: string, programId?: string | null): string {
  return `${programId ?? 'global'}:${key}`;
}

/** Invalidate one cached entry. Called by the service after a write. */
export function invalidateConfigCache(key: string, programId?: string | null): void {
  cache.delete(cacheKey(key, programId));
  // Also clear the global fallback when a per-program write happens — the
  // global is still a valid fallback for that key.
  cache.delete(cacheKey(key, null));
}

/** Clear the entire cache. Used by tests + bulk-import paths. */
export function clearAllConfigCache(): void {
  cache.clear();
}

// ── Schema default extraction ───────────────────────────────────────────────
//
// We lazily derive defaults from the existing Zod schema at
// apps/backend/src/config/schema.ts so we don't duplicate defaults in two
// places. Each top-level ZodObject has a `.shape` with `.default()` chains.
//
// For Phase 1 this is a simple lookup: we read the env var (Layer 2) and
// only fall to the schema default (Layer 1) when env is unset AND Mongo
// is unset. Reading the actual schema defaults would require importing
// the schema module here, which creates a circular dep risk (the
// schema imports from many places). For Phase 1 we accept that Layer 1
// returns `undefined` for keys not in env / Mongo — consumers should
// handle that gracefully.
//
// A future iteration can plug in a real schema lookup by passing the
// parsed config object in at startup.

function getSchemaDefault(key: string): unknown {
  try {
    const config = loadConfig();
    const parts = key.split('.');
    let current: any = config;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return current;
  } catch (err) {
    return undefined;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a single config value across the three layers.
 *
 * Returns `value: undefined` when the key isn't found anywhere AND no
 * schema default applies. Callers should treat undefined as "use the
 * code default" and not error out — this lets new keys ship without
 * needing to be added to AdminConfig.
 */
export async function getConfig(
  key: string,
  opts: RuntimeConfigOptions = {}
): Promise<ConfigLookupResult> {
  const programId = opts.programId == null
    ? null
    : typeof opts.programId === 'string'
      ? opts.programId
      : opts.programId.toString();
  const ck = cacheKey(key, programId);

  if (!opts.skipCache) {
    const hit = cache.get(ck);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const { isCritical } = categorize(key);

  // Layer 3: Mongo (per-program first, then global)
  const mongoResult = await lookupInMongo(key, programId);
  if (mongoResult) {
    const result: ConfigLookupResult = {
      value: mongoResult.value,
      source: 'mongo',
      isEncrypted: mongoResult.encrypted,
      key,
      category: isCritical ? 'critical' : 'non-critical',
      scope: programId ? 'program' : 'global',
      mongoId: mongoResult.mongoId,
    };
    cache.set(ck, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Layer 2: env
  const envVar = keyToEnvVar(key);
  if (process.env[envVar] !== undefined) {
    const result: ConfigLookupResult = {
      value: parseEnvValue(process.env[envVar]!),
      source: 'env',
      isEncrypted: false,
      key,
      category: isCritical ? 'critical' : 'non-critical',
      scope: programId ? 'program' : 'global',
    };
    cache.set(ck, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Layer 1: schema default
  const def = getSchemaDefault(key);
  if (def !== undefined) {
    const result: ConfigLookupResult = {
      value: def,
      source: 'default',
      isEncrypted: false,
      key,
      category: isCritical ? 'critical' : 'non-critical',
      scope: programId ? 'program' : 'global',
    };
    cache.set(ck, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Nothing found anywhere.
  const result: ConfigLookupResult = {
    value: undefined,
    source: 'default',
    isEncrypted: false,
    key,
    category: isCritical ? 'critical' : 'non-critical',
    scope: programId ? 'program' : 'global',
  };
  // Cache undefineds briefly too — saves repeated lookups for missing keys.
  cache.set(ck, { value: result, expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 5_000) });
  return result;
}

/**
 * Bulk-fetch every known config key. For Phase 1 this enumerates the
 * keys that appear in AdminConfig (Mongo) plus a small set of well-known
 * critical keys that we want surfaced even if no override exists.
 */
export async function listConfig(opts: RuntimeConfigOptions = {}): Promise<ConfigLookupResult[]> {
  const programId = opts.programId == null
    ? null
    : typeof opts.programId === 'string'
      ? opts.programId
      : opts.programId.toString();

  // Build the candidate key list. Mongo AdminConfig rows + a fixed
  // list of "always interesting" keys that should appear even when no
  // override exists. The fixed list is the set of critical env vars we
  // expect most installs to set.
  const mongoRows = await AdminConfig.find(programId ? { programId } : { programId: null })
    .select('key')
    .lean();
  const seenKeys = new Set<string>();
  for (const r of mongoRows) seenKeys.add(r.key);

  const ALWAYS_INTERESTING = [
    'jwt.secret',
    'encryption.masterKey',
    'mongodb.uri',
    'redis.url',
    'anthropic.apiKey',
    'openai.apiKey',
    'xai.apiKey',
    'minimax.apiKey',
    'anthropic.model',
    'openai.model',
    'featureFlag.goldenTicket.enabled',
    'featureFlag.aiAutoAnswer.enabled',
    'featureFlag.communityDuplicateDetection.enabled',
    'featureFlag.discordAdmin.enabled',
    'featureFlag.faqFreshness.enabled',
    'ai.duplicate.threshold',
    'rateLimit.login.max',
    'rateLimit.register.max',
    'rateLimit.register.windowMinutes',
    'log.level',
  ];
  for (const k of ALWAYS_INTERESTING) seenKeys.add(k);

  // Resolve each (parallel, but capped at 20 concurrent to avoid Mongo
  // fanout on huge key sets).
  const all = Array.from(seenKeys);
  const results: ConfigLookupResult[] = [];
  for (let i = 0; i < all.length; i += 20) {
    const slice = all.slice(i, i + 20);
    const sliceResults = await Promise.all(
      slice.map((k) => getConfig(k, { ...opts, skipCache: true }))
    );
    results.push(...sliceResults);
  }
  return results;
}

// ── Mongo lookup helper ─────────────────────────────────────────────────────

interface MongoLookupResult {
  value: unknown;
  encrypted: boolean;
  mongoId: string;
}

async function lookupInMongo(
  key: string,
  programId: string | null
): Promise<MongoLookupResult | null> {
  // Per-program override first.
  if (programId) {
    const row = await AdminConfig.findOne({ key, programId })
      .select('value encrypted _id')
      .lean();
    if (row) return formatMongoRow(row);
  }
  // Global override.
  const row = await AdminConfig.findOne({ key, programId: null })
    .select('value encrypted _id')
    .lean();
  if (row) return formatMongoRow(row);
  return null;
}

interface MongoRow {
  _id: unknown;
  value: string;
  encrypted: boolean;
}

function formatMongoRow(row: MongoRow): MongoLookupResult {
  const value = row.encrypted
    ? decryptStored(row.value)
    : tryParseJson(row.value);
  return {
    value,
    encrypted: row.encrypted,
    mongoId: String(row._id),
  };
}

// Lazy-imported crypto to avoid hard-coupling the resolver to the
// encryption module at module-load time.
let _encrypt: ((s: string) => string) | null = null;
let _decrypt: ((s: string) => string) | null = null;

function getCrypto() {
  if (!_encrypt || !_decrypt) {
    // Synchronous require — the crypto module has no async setup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
// eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encrypt, decrypt } = require('../utils/auth/crypto.js');
    _encrypt = encrypt;
    _decrypt = decrypt;
  }
  return { encrypt: _encrypt!, decrypt: _decrypt! };
}


function decryptStored(ciphertext: string): string {
  return getCrypto().decrypt(ciphertext);
}

/**
 * Try to parse a stored non-encrypted value as JSON; fall back to the
 * raw string. JSON-parsing lets us preserve typed values across the
 * write/read round-trip without separate type columns.
 */
function tryParseJson(raw: string): unknown {
  if (raw.length === 0) return '';
  // Cheap fast-path for the common non-JSON cases.
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  // JSON?
  if (raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

/**
 * Encode any JS value to a string suitable for storage in
 * AdminConfig.value. Used by the write side. Mirrors parseEnvValue's
 * type coercion so read + write are symmetric.
 */
export function stringifyForStore(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}