import { Router } from 'express';
import {
  getAllPosts,
  getPostById,
} from './post-reads.controller.js';
import {
  createPost,
  toggleUpvote,
  deletePost,
  reportPost,
  updatePost,
} from './post-mutations.controller.js';
import {
  resolvePost,
  requestExpertHelp,
  convertCommunityPostToFAQ,
  setPostDNA,
  setPostTags,
} from './post-lifecycle.controller.js';
import {
  objectToPromotion,
  confirmSpam,
  hidePost,
  unhidePost,
  lockPost,
  unlockPost,
} from './post-moderation.controller.js';
import { getSolvedPosts } from './post-reads.controller.js';
import { checkDuplicateController, resolveDeflectionController } from './post-duplicate.controller.js';
import {
  getAnswersList,
  addComment,
  verifyComment,
  setCommentDNA,
  clearCommentDNA,
  acceptCommentAnswer,
  updateComment,
  deleteComment,
} from './comment.controller.js';
import { toggleCommentUpvote, toggleCommentDownvote } from './comment-vote.controller.js';
import { searchCommunityPosts } from './community-search.controller.js';
import { getReviewQueue } from '../faq/freshness.controller.js';
import { getBookmarks, toggleBookmark } from './bookmark.controller.js';
import { getCommunityStats } from './community-stats.controller.js';
import { getRelatedForPost } from '../faq/related.controller.js';
import { protect, authorize } from '../../middleware/auth.js';
import { validateObjectId } from '../../middleware/validateObjectId.js';
import { validateBody, createPostSchema, addCommentSchema, resolvePostSchema, reportPostSchema, checkDuplicateSchema } from '../../utils/auth/validation.js';

const router = Router();

// Public read-only routes — anonymous users can browse community posts freely.
// (User-specific actions like bookmarks and admin/moderator actions like
//  review-queue remain protected below.)
router.get('/search', searchCommunityPosts);
router.get('/solved', getSolvedPosts);
router.get('/answers/list', getAnswersList);
router.get('/stats', getCommunityStats);

// Protected non-parameterised routes must come BEFORE /:id to avoid the
// wildcard swallowing "bookmarks" / "review-queue" as a post ID.
router.get('/review-queue', protect, authorize('admin', 'moderator'), getReviewQueue);
router.get('/bookmarks', protect, getBookmarks);

router.get('/', getAllPosts);
// Audit fix: frontend calls `/community/posts` (literal); without this
// entry, Express falls through to `/:id` and tries ObjectId('posts') → 500.
router.get('/posts', getAllPosts);
// M4-3 (cross-cutting Pattern A) fix: validate `:id` on every route
// that takes a post id. Previously the controller's
// `CommunityPost.findById(req.params.id)` threw a CastError on
// malformed ids → 500. With `validateObjectId('id')` mounted before
// each handler, malformed ids return 400 cleanly. The pattern
// applies to every community route below.
router.get('/:id', validateObjectId('id'), getPostById);
router.get('/:id/related', validateObjectId('id'), getRelatedForPost);

router.post('/check-duplicate', protect, validateBody(checkDuplicateSchema), checkDuplicateController);
router.post('/resolve-deflection', protect, resolveDeflectionController);

router.post('/', protect, validateBody(createPostSchema), createPost);
// M4-5 (MEDIUM) fix: `toggleUpvote` previously read `alreadyUpvoted`
// BEFORE the atomic update (see post-mutations.controller.ts:272).
// Two concurrent upvotes could both pass the check and both increment
// in the same $addToSet, producing a phantom vote. The fix is
// upstream in the controller (atomic `findOneAndUpdate({$ne})`);
// validateObjectId('id') here is the Pattern A safety net.
router.post('/:id/upvote', protect, validateObjectId('id'), toggleUpvote);
router.post('/:id/comments', protect, validateObjectId('id'), validateBody(addCommentSchema), addComment);
router.post('/:id/comments/:commentId/upvote', protect, validateObjectId('id', 'commentId'), toggleCommentUpvote);
router.post('/:id/comments/:commentId/downvote', protect, validateObjectId('id', 'commentId'), toggleCommentDownvote);
router.patch('/:id/comments/:commentId/verify', protect, authorize('admin', 'moderator'), validateObjectId('id', 'commentId'), verifyComment);
router.patch('/:id/comments/:commentId/accept-answer', protect, validateObjectId('id', 'commentId'), acceptCommentAnswer);
router.patch('/:id/comments/:commentId', protect, validateObjectId('id', 'commentId'), updateComment);
router.delete('/:id/comments/:commentId', protect, validateObjectId('id', 'commentId'), deleteComment);
router.patch('/:id/comments/:commentId/dna', protect, authorize('admin', 'moderator'), validateObjectId('id', 'commentId'), setCommentDNA);
router.delete('/:id/comments/:commentId/dna', protect, authorize('admin', 'moderator'), validateObjectId('id', 'commentId'), clearCommentDNA);
router.patch('/:id/resolve', protect, validateObjectId('id'), validateBody(resolvePostSchema), resolvePost);
router.post('/:id/request-expert', protect, validateObjectId('id'), requestExpertHelp);
router.post('/:id/report', protect, validateObjectId('id'), validateBody(reportPostSchema), reportPost);
router.post('/:id/bookmark', protect, validateObjectId('id'), toggleBookmark);
router.post('/:id/object-to-promotion', protect, authorize('admin', 'moderator'), validateObjectId('id'), objectToPromotion);
router.post('/:id/confirm-spam', protect, authorize('admin', 'moderator'), validateObjectId('id'), confirmSpam);
router.post('/:id/hide', protect, authorize('admin', 'moderator'), validateObjectId('id'), hidePost);
router.post('/:id/unhide', protect, authorize('admin', 'moderator'), validateObjectId('id'), unhidePost);
router.post('/:id/lock', protect, authorize('admin', 'moderator'), validateObjectId('id'), lockPost);
router.post('/:id/unlock', protect, authorize('admin', 'moderator'), validateObjectId('id'), unlockPost);
router.post('/:id/convert-to-faq', protect, authorize('admin'), validateObjectId('id'), convertCommunityPostToFAQ);
router.patch('/:id/dna', protect, validateObjectId('id'), setPostDNA);
router.patch('/:id/tags', protect, validateObjectId('id'), setPostTags);
router.patch('/:id', protect, validateObjectId('id'), updatePost);
router.delete('/:id', protect, validateObjectId('id'), deletePost);

export default router;
