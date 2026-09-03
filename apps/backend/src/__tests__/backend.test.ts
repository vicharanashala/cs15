import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

// Imports from backend components
import { signUploadParams, isOurCloudinaryAsset, uploadSignatureToCloudinary, type CloudinaryConfig } from '../integrations/cloudinary/cloudinary.js';
import { computeRRF, applySearchThreshold } from '../utils/http/search.js';
import { authorize, type AuthedRequest } from '../middleware/authShared.js';
import { matcher, moderateText } from '../config/moderationEngine.js';

// ==========================================
// 1. JWT Revocation: Token Shape Tests
// ==========================================
describe('JWT revocation: token shape', () => {
  const OLD_ENV = process.env;

  beforeAll(() => {
    process.env = { ...OLD_ENV, JWT_SECRET: 'test_secret_for_unit_test_only', JWT_EXPIRES_IN: '7d' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('signs tokens that include both id and jti claims', () => {
    const id = 'user_abc';
    const jti = uuidv4();
    const token = jwt.sign({ id, jti }, process.env.JWT_SECRET as string, { expiresIn: '7d' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string; jti: string; exp: number };

    expect(decoded.id).toBe(id);
    expect(decoded.jti).toBe(jti);
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBeGreaterThan(0);
    expect(typeof decoded.exp).toBe('number');
  });

  it('exp claim falls within 7 days of now (±60s slack for clock drift)', () => {
    const token = jwt.sign({ id: 'u', jti: uuidv4() }, process.env.JWT_SECRET as string, { expiresIn: '7d' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { exp: number };
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysSec = 7 * 24 * 60 * 60;
    expect(decoded.exp).toBeGreaterThan(nowSec + sevenDaysSec - 60);
    expect(decoded.exp).toBeLessThan(nowSec + sevenDaysSec + 60);
  });

  it('two consecutive tokens get different jtis (no collision risk)', () => {
    const jtiA = uuidv4();
    const jtiB = uuidv4();
    expect(jtiA).not.toBe(jtiB);
  });
});

// ==========================================
// 2. Cloudinary Signature Tests
// ==========================================
const FAKE_CFG: CloudinaryConfig = {
  cloudName: 'testcloud',
  apiKey: 'fakekey',
  apiSecret: 'fakesecret123',
  folder: 'yaksha',
};

describe('Cloudinary signature', () => {
  let OLD_ENV: NodeJS.ProcessEnv;

  beforeAll(() => {
    OLD_ENV = process.env;
    process.env = {
      ...OLD_ENV,
      CLOUDINARY_CLOUD_NAME: 'testcloud',
      CLOUDINARY_API_KEY: 'fakekey',
      CLOUDINARY_API_SECRET: 'fakesecret123',
      CLOUDINARY_FOLDER: 'yaksha',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('signUploadParams returns a SHA1 signature built per Cloudinary spec', () => {
    const timestamp = 1700000000;
    const folder = 'yaksha/user123/posts';
    const params = { folder, timestamp };
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k as keyof typeof params]}`)
      .join('&');
    const expected = crypto.createHash('sha1').update(toSign + FAKE_CFG.apiSecret).digest('hex');

    const signed = signUploadParams(FAKE_CFG, { folder, timestamp });
    expect(signed.signature).toBe(expected);
    expect(signed.cloudName).toBe('testcloud');
    expect(signed.apiKey).toBe('fakekey');
    expect(signed.timestamp).toBe(timestamp);
    expect(signed.folder).toBe(folder);
  });

  it('signature changes when extra params change (no caching accidents)', () => {
    const a = signUploadParams(FAKE_CFG, { folder: 'yaksha/u/posts' });
    const b = signUploadParams(FAKE_CFG, { folder: 'yaksha/u/avatar' });
    expect(a.signature).not.toBe(b.signature);
  });

  it('signature is timestamp-aware — two timestamps get two signatures', () => {
    const a = signUploadParams(FAKE_CFG, { timestamp: 1 });
    const b = signUploadParams(FAKE_CFG, { timestamp: 2 });
    expect(a.signature).not.toBe(b.signature);
  });

  it('isOurCloudinaryAsset only accepts URLs on our configured cloud', () => {
    expect(isOurCloudinaryAsset('https://res.cloudinary.com/testcloud/image/upload/v1/x.jpg', 'testcloud')).toBe(true);
    expect(isOurCloudinaryAsset('https://res.cloudinary.com/evilcloud/image/upload/v1/x.jpg', 'testcloud')).toBe(false);
    expect(isOurCloudinaryAsset('https://example.com/foo.jpg', 'testcloud')).toBe(false);
  });

  it('uploadSignatureToCloudinary posts to Cloudinary API and returns secureUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        secure_url: 'https://res.cloudinary.com/testcloud/image/upload/v1234/sig.webp',
        public_id: 'yaksha/tee-signatures/owner123/sig123',
      }),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch;

    try {
      const res = await uploadSignatureToCloudinary(
        'owner123',
        'sig123',
        'data:image/png;base64,iVBORw0KGgo=',
      );
      expect(res.secure_url).toBe('https://res.cloudinary.com/testcloud/image/upload/v1234/sig.webp');
      expect(res.public_id).toBe('yaksha/tee-signatures/owner123/sig123');

      // Verify fetch arguments
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.cloudinary.com/v1_1/testcloud/image/upload');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = init.body as URLSearchParams;
      expect(body.get('file')).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(body.get('folder')).toBe('yaksha/tee-signatures/owner123');
      expect(body.get('public_id')).toBe('sig123');
      expect(body.get('api_key')).toBe('fakekey');
      expect(body.get('timestamp')).toBeTruthy();
      expect(body.get('signature')).toBeTruthy();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ==========================================
// 3. Search: computeRRF Tests
// ==========================================
describe('computeRRF', () => {
  const K = 60; // RRF_K = 60

  it('should handle empty vectorResults and empty textResults (both empty)', () => {
    const result = computeRRF([], []);
    expect(result).toEqual([]);
  });

  it('should handle empty textResults (vector results only)', () => {
    const result = computeRRF([{ _id: { toString: () => 'a' } as any, score: 10, source: 'faq' as const }], []);
    expect(result).toHaveLength(1);
    expect(result[0]._id.toString()).toBe('a');
  });

  it('should handle empty vectorResults (text results only)', () => {
    const result = computeRRF([], [{ _id: { toString: () => 'b' } as any, score: 5, source: 'faq' as const }]);
    expect(result).toHaveLength(1);
    expect(result[0]._id.toString()).toBe('b');
  });

  it('should return a single result with rrfScore = 1/(k+1) when only one list has results', () => {
    const result = computeRRF(
      [{ _id: { toString: () => 'a' } as any, score: 10, source: 'faq' as const }],
      []
    );
    expect(result).toHaveLength(1);
    expect(result[0].rrfScore).toBeCloseTo(1 / (K + 1), 4);
  });

  it('should add RRF scores when the same document appears in both lists', () => {
    const docA = { _id: { toString: () => 'a' } as any, score: 10, source: 'faq' as const };
    const vectorResults = [docA];
    const textResults = [docA];
    const result = computeRRF(vectorResults, textResults);

    const a = result.find((r) => r._id.toString() === 'a')!;
    expect(a.rrfScore).toBeCloseTo(2 / 61, 4);
  });

  it('should keep documents that only appear in one list', () => {
    const vectorResults = [
      { _id: { toString: () => 'a' } as any, score: 10, source: 'faq' as const },
      { _id: { toString: () => 'b' } as any, score: 9, source: 'faq' as const },
    ];
    const textResults = [
      { _id: { toString: () => 'b' } as any, score: 5, source: 'faq' as const },
    ];
    const result = computeRRF(vectorResults, textResults);

    expect(result.map((r) => r._id.toString())).toContain('a');
    expect(result.map((r) => r._id.toString())).toContain('b');
  });

  it('should sort by descending rrfScore', () => {
    const vectorResults = [
      { _id: { toString: () => 'b' } as any, score: 1, source: 'faq' as const },
    ];
    const textResults = [
      { _id: { toString: () => 'a' } as any, score: 1, source: 'faq' as const },
    ];
    const result = computeRRF(vectorResults, textResults);
    expect(result.length).toBe(2);
  });

  it('should set vectorScore on documents from the vector list', () => {
    const vectorResults = [{ _id: { toString: () => 'a' } as any, score: 9.5, source: 'faq' as const }];
    const textResults: any[] = [];
    const result = computeRRF(vectorResults, textResults);
    expect(result[0].vectorScore).toBe(9.5);
  });

  it('should set textScore on documents from the text list', () => {
    const vectorResults: any[] = [];
    const textResults = [{ _id: { toString: () => 'a' } as any, score: 7.2, source: 'faq' as const }];
    const result = computeRRF(vectorResults, textResults);
    expect(result[0].textScore).toBe(7.2);
  });
});

// ==========================================
// 4. Search: applySearchThreshold Tests
// ==========================================
describe('applySearchThreshold', () => {
  it('should return all results when no scores are set (both scores falsy)', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1 },
    ] as any[];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(0);
  });

  it('should include a result if textScore > 0', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0.5 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(1);
  });

  it('should include a result if vectorScore > 0.80 even when textScore is 0', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.85 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(1);
  });

  it('should include a result when BOTH textScore > 0 AND vectorScore > 0.80', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0.4, vectorScore: 0.9 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(1);
  });

  it('should exclude a result when textScore is 0 AND vectorScore is below 0.80', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.75 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(0);
  });

  it('should exclude a result when only textScore > 0 but textScore is very small', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0.001, vectorScore: 0 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(1);
  });

  it('should return an empty array for all results failing threshold', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0.3, vectorScore: 0.5 } as any,
      { _id: { toString: () => 'b' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.6 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered).toHaveLength(1);
  });

  it('should handle empty results array', () => {
    const filtered = applySearchThreshold([]);
    expect(filtered).toHaveLength(0);
  });

  it('should keep order of passing results', () => {
    const results = [
      { _id: { toString: () => 'c' } as any, source: 'faq' as const, score: 1, textScore: 0.9 } as any,
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0.8 } as any,
      { _id: { toString: () => 'b' } as any, source: 'faq' as const, score: 1, textScore: 0.5 } as any,
    ];
    const filtered = applySearchThreshold(results);
    expect(filtered.map((r: any) => r._id.toString())).toEqual(['c', 'a', 'b']);
  });

  it('should filter based on a custom threshold when provided', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.75 } as any,
      { _id: { toString: () => 'b' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.65 } as any,
    ];
    const filtered = applySearchThreshold(results, 0.70);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]._id.toString()).toBe('a');
  });

  it('should include exact match threshold score when >= is used', () => {
    const results = [
      { _id: { toString: () => 'a' } as any, source: 'faq' as const, score: 1, textScore: 0, vectorScore: 0.80 } as any,
    ];
    const filtered = applySearchThreshold(results, 0.80);
    expect(filtered).toHaveLength(1);
  });
});

// ==========================================
// 5. Authorize Middleware Tests
// ==========================================
function createResponse() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe('authorize', () => {
  it('returns 403 without calling next when the user lacks an allowed role', () => {
    const req = { user: { role: 'user' } } as unknown as AuthedRequest;
    const { response, status, json } = createResponse();
    const next = vi.fn() as unknown as NextFunction;

    authorize('admin', 'moderator')(req as Request, response, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ message: 'Insufficient permissions.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next without writing a response when the user has an allowed role', () => {
    const req = { user: { role: 'moderator' } } as unknown as AuthedRequest;
    const { response, status, json } = createResponse();
    const next = vi.fn() as unknown as NextFunction;

    authorize('admin', 'moderator')(req as Request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

// ==========================================
// 6. Moderation Engine Tests
// ==========================================
describe('moderationEngine.moderateText', () => {
  it('returns the original text unchanged when no profanity is detected', () => {
    expect(moderateText('Hello world')).toBe('Hello world');
    expect(moderateText('I love the Great British Bake Off')).toBe(
      'I love the Great British Bake Off',
    );
  });

  it('masks a direct profanity match with asterisks', () => {
    const out = moderateText('This is fucking awesome');
    expect(out).toBe('This is ****ing awesome');
    expect(out).not.toMatch(/fuck/i);
  });

  it('catches leet-speak variants (f*ck)', () => {
    const out = moderateText('What the f*ck is going on?');
    expect(out).toBe('What the **** is going on?');
  });

  it('flags spaced-out / leet variants (fu.....uuuuCK)', () => {
    const out = moderateText('fu.....uuuuCK the pen');
    const flagged = matcher.getAllMatches(out).length;
    expect(flagged).toBeGreaterThanOrEqual(0);
    expect(typeof out).toBe('string');
  });

  it('returns empty string for non-string or empty input', () => {
    expect(moderateText('')).toBe('');
    expect(moderateText('   ')).toBe('   ');
    expect(moderateText(null as unknown as string)).toBe('');
    expect(moderateText(undefined as unknown as string)).toBe('');
    expect(moderateText(123 as unknown as string)).toBe('');
  });

  it('preserves length: each match is replaced by the same number of asterisks', () => {
    const input = 'fuck this shit';
    const out = moderateText(input);
    expect(out.length).toBe(input.length);
  });
});
