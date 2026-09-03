/*
 * Phase 3: Cloudinary → GCS migration script.
 *
 * For every User.avatar and CommunityPost.attachments[] entry with provider
 * `cloudinary`:
 *   1. Download the asset bytes from Cloudinary (via secure_url)
 *   2. Upload to GCS via signed URL flow (server-side equivalent)
 *   3. Update the DB row to the new GCS shape
 *
 * Run with --dry-run first to see what would change. Re-runs are safe:
 * already-migrated assets are skipped.
 *
 * Usage:
 *   npx tsx scripts/migrate-cloudinary-to-gcs.ts --dry-run
 *   npx tsx scripts/migrate-cloudinary-to-gcs.ts             # actual run
 *   npx tsx scripts/migrate-cloudinary-to-gcs.ts --batch=50   # custom batch size
 */
import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local' });

import mongoose from 'mongoose';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';

// Load models dynamically so we don't have to compile the whole backend.
import User from '../modules/auth/user.model.js';
import CommunityPost from '../modules/community/community-post.model.js';

interface MigrationStats {
  avatarsScanned: number;
  avatarsMigrated: number;
  attachmentsScanned: number;
  attachmentsMigrated: number;
  errors: Array<{ kind: string; id: string; url: string; message: string }>;
}

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--batch='));
  return arg ? parseInt(arg.split('=')[1], 10) : 100;
})();

async function downloadFromCloudinary(secureUrl: string): Promise<Buffer> {
  const res = await fetch(secureUrl);
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadToGcs(opts: {
  bucket: ReturnType<Storage['bucket']>;
  subfolder: string;
  userId: string;
  contentType: string;
  bytes: Buffer;
  oldPublicId?: string;
}): Promise<{ publicUrl: string; gcsUri: string; objectPath: string }> {
  const safeName = opts.oldPublicId
    ? opts.oldPublicId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file'
    : 'migrated';
  const uuid = randomUUID().replace(/-/g, '').slice(0, 12);
 
  const objectPath = `${opts.subfolder}/${opts.userId}/${uuid}-${safeName}`;
  const file = opts.bucket.file(objectPath);
  await file.save(opts.bytes, {
    contentType: opts.contentType,
    metadata: { migratedFromCloudinary: 'true', migratedAt: new Date().toISOString() },
  });
  // Make public-read so the CDN URL works without signing
  await file.makePublic();
  const publicHost = (process.env.GCS_PUBLIC_HOST ?? 'media.mydomain.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const bucketName = opts.bucket.name;
  return {
    publicUrl: `https://${publicHost}/${objectPath}`,
    gcsUri: `gs://${bucketName}/${objectPath}`,
    objectPath,
  };
}

function inferContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[ext] ?? 'image/jpeg';
}

async function migrateAvatars(storage: Storage, stats: MigrationStats): Promise<void> {
  console.log(`\n── Scanning User.avatar (batch=${BATCH_SIZE}, dry_run=${DRY_RUN}) ──`);

  // Find users with a Cloudinary-shaped avatar (has publicId, not gcsUri).
  const cursor = User.find({
    'avatar.url': { $exists: true, $ne: null },
    'avatar.publicId': { $exists: true, $ne: null },
    'avatar.gcsUri': { $exists: false },
  })
    .select('_id avatar')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  const bucket = storage.bucket(process.env.GCS_BUCKET!);

  for await (const user of cursor) {
    stats.avatarsScanned++;
    const avatar = (user as unknown as { avatar?: { url?: string; publicId?: string } }).avatar;
    if (!avatar?.url || !avatar.publicId) continue;

    // Skip non-Cloudinary URLs (e.g. if someone already started migrating)
    if (!avatar.url.includes('res.cloudinary.com/')) {
      console.log(`  → user ${user._id}: avatar URL not Cloudinary, skipping`);
      continue;
    }

    try {
      if (DRY_RUN) {
        console.log(`  [dry-run] would migrate avatar for user ${user._id}: ${avatar.url}`);
        stats.avatarsMigrated++;
        continue;
      }

      const bytes = await downloadFromCloudinary(avatar.url);
      const contentType = inferContentType(avatar.publicId);
      const migrated = await uploadToGcs({
        bucket,
        subfolder: 'avatar',
        userId: String(user._id),
        contentType,
        bytes,
        oldPublicId: avatar.publicId,
      });

      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            avatar: {
              url: migrated.publicUrl,
              gcsUri: migrated.gcsUri,
              objectPath: migrated.objectPath,
            },
          },
        }
      );
      stats.avatarsMigrated++;
      console.log(`  ✓ migrated avatar for user ${user._id}`);
    } catch (err) {
      const message = (err as Error).message;
      stats.errors.push({ kind: 'avatar', id: String(user._id), url: avatar.url, message });
      console.error(`  ✗ avatar ${user._id}: ${message}`);
    }
  }
}

async function migrateAttachments(storage: Storage, stats: MigrationStats): Promise<void> {
  console.log(`\n── Scanning CommunityPost.attachments (batch=${BATCH_SIZE}, dry_run=${DRY_RUN}) ──`);

  // Find posts with Cloudinary-shaped attachments (have publicId but not gcsUri).
  const cursor = CommunityPost.find({
    attachments: { $exists: true, $ne: [] },
    'attachments.publicId': { $exists: true, $ne: null },
    'attachments.gcsUri': { $exists: false },
  })
    .select('_id author attachments')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  const bucket = storage.bucket(process.env.GCS_BUCKET!);

  for await (const post of cursor) {
    const attachments = (post as unknown as {
      attachments?: Array<{ url?: string; publicId?: string; format?: string }>;
      author?: { _id?: unknown } | unknown;
    }).attachments ?? [];
    const authorId = String(((post as unknown as { author?: { _id?: unknown } | unknown }).author as { _id?: unknown })?._id ?? (post as unknown as { author?: unknown }).author);

    const newAttachments = [];
    let postChanged = false;

    for (const att of attachments) {
      stats.attachmentsScanned++;
      if (!att?.url || !att.publicId) continue;
      if (!att.url.includes('res.cloudinary.com/')) {
        newAttachments.push(att);
        continue;
      }

      try {
        if (DRY_RUN) {
          console.log(`  [dry-run] would migrate attachment on post ${post._id}: ${att.url}`);
          newAttachments.push({
            url: 'https://placeholder.example/dry-run',
            gcsUri: 'gs://placeholder/dry-run',
            objectPath: 'placeholder',
            width: att.format ? undefined : undefined,
          });
          stats.attachmentsMigrated++;
          postChanged = true;
          continue;
        }

        const bytes = await downloadFromCloudinary(att.url);
        const contentType = att.format ? `image/${att.format}` : inferContentType(att.publicId);
        const migrated = await uploadToGcs({
          bucket,
          subfolder: 'posts',
          userId: authorId,
          contentType,
          bytes,
          oldPublicId: att.publicId,
        });

        newAttachments.push({
          url: migrated.publicUrl,
          gcsUri: migrated.gcsUri,
          objectPath: migrated.objectPath,
        });
        stats.attachmentsMigrated++;
        postChanged = true;
        console.log(`  ✓ migrated attachment on post ${post._id}`);
      } catch (err) {
        const message = (err as Error).message;
        stats.errors.push({ kind: 'attachment', id: String(post._id), url: att.url, message });
        console.error(`  ✗ attachment on ${post._id}: ${message}`);
        newAttachments.push(att); // keep the original on error
      }
    }

    if (postChanged && !DRY_RUN) {
      await CommunityPost.updateOne({ _id: post._id }, { $set: { attachments: newAttachments } });
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.GCS_BUCKET) {
    console.error('GCS_BUCKET is required');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const storage = new Storage();
  const stats: MigrationStats = {
    avatarsScanned: 0,
    avatarsMigrated: 0,
    attachmentsScanned: 0,
    attachmentsMigrated: 0,
    errors: [],
  };

  await migrateAvatars(storage, stats);
  await migrateAttachments(storage, stats);

  console.log('\n── Migration complete ──');
  console.log(`Avatars:     scanned=${stats.avatarsScanned} migrated=${stats.avatarsMigrated}`);
  console.log(`Attachments: scanned=${stats.attachmentsScanned} migrated=${stats.attachmentsMigrated}`);
  console.log(`Errors:      ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log('\nError summary:');
    for (const e of stats.errors.slice(0, 10)) {
      console.log(`  ${e.kind} ${e.id}: ${e.message} (${e.url})`);
    }
    if (stats.errors.length > 10) console.log(`  ... and ${stats.errors.length - 10} more`);
  }

  await mongoose.disconnect();
  // Don't process.exit — let event loop drain so @google-cloud/storage native can clean up.
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});