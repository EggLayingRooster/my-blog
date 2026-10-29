import {
  createAdminTestContext,
  seedUser,
  waitForBackgroundTasks,
} from "tests/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as PostMediaRepo from "@/features/posts/data/post-media.data";
import * as PostService from "@/features/posts/services/posts.service";
import { unwrap } from "@/lib/errors";
import * as Storage from "./data/media.storage";
import * as MediaService from "./service/media.service";

/**
 * MediaService Tests
 *
 * R2 operations are mocked at the storage layer to avoid Miniflare R2 isolation issues.
 * These are integration tests focused on:
 * - Service layer logic
 * - DB operations (using real D1)
 * - Rollback behavior
 * - Post-Media relationships
 */
describe("MediaService", () => {
  let adminContext: ReturnType<typeof createAdminTestContext>;

  const IMAGE_SIGNATURES: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

function createImageFile(
  name: string,
  type: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
  size = 0,
): File {
  const signature = IMAGE_SIGNATURES[type];
  const total = Math.max(size, signature.length);
  const bytes = new Uint8Array(total);
  bytes.set(signature);
  return new File([bytes], name, { type });
}
// Mock R2 storage functions
  beforeEach(async () => {
    adminContext = createAdminTestContext();
    await seedUser(adminContext.db, adminContext.session.user);

    // Mock R2 operations at storage layer to avoid Miniflare R2 isolation/serialization issues.
    // We trust the `r2-sanity.test.ts` (or equivalent verification) matches the platform behavior,
    // and here we focus on Service Logic + DB integration.

    vi.spyOn(Storage, "putToR2").mockImplementation(async (_env, file) => {
      const key = `mocked-${Date.now()}-${file.name}`;
      return {
        key,
        url: `/images/${key}`,
        fileName: file.name,
        mimeType: file.type,
        sizeInBytes: file.size,
      };
    });

    vi.spyOn(Storage, "deleteFromR2").mockResolvedValue(undefined);
    vi.spyOn(Storage, "getFromR2").mockResolvedValue(null);
  });

  // ============================================
  // 上传流程 (Upload Flow)
  // ============================================
  describe("Upload Flow", () => {
    it("should upload file and create DB record", async () => {
      const file = createImageFile("test-image.png", "image/png");

      const result = unwrap(await MediaService.upload(adminContext, { file }));

      expect(result).toMatchObject({
        fileName: "test-image.png",
        mimeType: "image/png",
      });
      expect(result.key).toContain("mocked-");
      expect(result.url).toContain("/images/");

      // Verify Storage.putToR2 was called
      expect(Storage.putToR2).toHaveBeenCalledWith(
        adminContext.env,
        file,
        expect.objectContaining({ contentType: "image/png", extension: "png" }),
      );

      // Verify DB record was created
      const mediaList = await MediaService.getMediaList(adminContext, {});
      expect(mediaList.items.some((m) => m.key === result.key)).toBeTruthy();
    });

    it("should rollback R2 upload when DB insert fails", async () => {
      const file = createImageFile("rollback-test.png", "image/png");

      // Make putToR2 work but insertMedia fail
      const mockKey = `rollback-key-${Date.now()}`;
      vi.mocked(Storage.putToR2).mockResolvedValueOnce({
        key: mockKey,
        url: `/images/${mockKey}`,
        fileName: file.name,
        mimeType: file.type,
        sizeInBytes: file.size,
      });

      // Import and mock the repo
      const MediaRepo = await import("./data/media.data");
      vi.spyOn(MediaRepo, "insertMedia").mockRejectedValueOnce(
        new Error("DB Error"),
      );

      const result = await MediaService.upload(adminContext, { file });
      expect(result.error?.reason).toBe("MEDIA_RECORD_CREATE_FAILED");

      // Wait for rollback
      await waitForBackgroundTasks(adminContext.executionCtx);

      // Verify deleteFromR2 was called with the uploaded key
      expect(Storage.deleteFromR2).toHaveBeenCalledWith(
        adminContext.env,
        mockKey,
      );
    });

    it("should calculate correct file size", async () => {
      const file = createImageFile("sized-file.jpg", "image/jpeg", 1024);

      const result = unwrap(await MediaService.upload(adminContext, { file }));

      expect(result.sizeInBytes).toBe(1024);
    });
  });

  // ============================================
  // 删除流程 (Deletion Flow)
  // ============================================
  describe("Deletion Flow", () => {
    it("should delete from both DB and trigger R2 cleanup", async () => {
      // First upload a file
      const file = createImageFile("to-delete.png", "image/png");
      const uploaded = unwrap(
        await MediaService.upload(adminContext, { file }),
      );

      // Reset mock to track deletion call
      vi.mocked(Storage.deleteFromR2).mockClear();

      // Delete it
      unwrap(await MediaService.deleteImage(adminContext, uploaded.key));

      // Wait for R2 deletion in waitUntil
      await waitForBackgroundTasks(adminContext.executionCtx);

      // Verify DB record is gone
      const mediaList = await MediaService.getMediaList(adminContext, {});
      expect(
        mediaList.items.find((m) => m.key === uploaded.key),
      ).toBeUndefined();

      // Verify R2 deleteFromR2 was called
      expect(Storage.deleteFromR2).toHaveBeenCalledWith(
        adminContext.env,
        uploaded.key,
      );
    });
  });

  // ============================================
  // 媒体查询 (Media Queries)
  // ============================================
  describe("Media Queries", () => {
    beforeEach(async () => {
      // Upload some test files
      for (let i = 1; i <= 5; i++) {
        const file = createImageFile(`query-test-${i}.png`, "image/png");
        unwrap(await MediaService.upload(adminContext, { file }));
      }
    });

    it("should list media with pagination", async () => {
      const result = await MediaService.getMediaList(adminContext, {
        limit: 3,
      });

      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
    });

    it("should fetch next page using cursor", async () => {
      const firstPage = await MediaService.getMediaList(adminContext, {
        limit: 3,
      });
      const secondPage = await MediaService.getMediaList(adminContext, {
        limit: 3,
        cursor: firstPage.nextCursor!,
      });

      expect(secondPage.items).toHaveLength(2); // 5 total, 3 in first page
      expect(secondPage.nextCursor).toBeNull();

      // Ensure no duplicates between pages
      const firstIds = firstPage.items.map((m) => m.id);
      const secondIds = secondPage.items.map((m) => m.id);
      expect(firstIds.some((id) => secondIds.includes(id))).toBeFalsy();
    });

    it("should search media by filename", async () => {
      // Upload a uniquely named file
      const uniqueFile = createImageFile("special-unique-file.png", "image/png");
      unwrap(await MediaService.upload(adminContext, { file: uniqueFile }));

      const result = await MediaService.getMediaList(adminContext, {
        search: "special-unique",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].fileName).toBe("special-unique-file.png");
    });

    it("should calculate total media size", async () => {
      const totalSize = await MediaService.getTotalMediaSize(adminContext);

      // 5 files with "content X" = roughly 9 bytes each
      expect(totalSize).toBeGreaterThan(0);
    });

    it("should update media filename", async () => {
      const file = createImageFile("original-name.png", "image/png");
      const uploaded = unwrap(
        await MediaService.upload(adminContext, { file }),
      );

      await MediaService.updateMediaName(adminContext, {
        key: uploaded.key,
        name: "new-fancy-name.png",
      });

      const list = await MediaService.getMediaList(adminContext, {
        search: "new-fancy-name",
      });
      expect(list.items).toHaveLength(1);
    });
  });

  // ============================================
  // 文章-媒体关联 (Post-Media Relationships)
  // ============================================
  describe("Post-Media Relationships", () => {
    it("should track media usage in posts", async () => {
      // Upload media
      const file = createImageFile("linked-image.png", "image/png");
      const media = unwrap(await MediaService.upload(adminContext, { file }));

      // Create a post
      const { id: postId } = await PostService.createEmptyPost(adminContext);

      // Sync post-media relationship
      await PostMediaRepo.syncPostMedia(adminContext.db, postId, {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: `/images/${media.key}` },
          },
        ],
      });

      // Check if media is in use
      const isInUse = await MediaService.isMediaInUse(adminContext, media.key);
      expect(isInUse).toBe(true);

      // Get linked posts
      const linkedPosts = await MediaService.getLinkedPosts(
        adminContext,
        media.key,
      );
      expect(linkedPosts).toHaveLength(1);
    });

    it("should return false for unused media", async () => {
      const file = createImageFile("unused-image.png", "image/png");
      const media = unwrap(await MediaService.upload(adminContext, { file }));

      const isInUse = await MediaService.isMediaInUse(adminContext, media.key);
      expect(isInUse).toBe(false);
    });

    it("should batch check linked media keys", async () => {
      // Upload multiple media files
      const files = ["batch-1.png", "batch-2.png", "batch-3.png"];
      const mediaKeys: Array<string> = [];

      for (const fileName of files) {
        const file = createImageFile(fileName, "image/png");
        const media = unwrap(await MediaService.upload(adminContext, { file }));
        mediaKeys.push(media.key);
      }

      // Link only first two to a post
      const { id: postId } = await PostService.createEmptyPost(adminContext);
      await PostMediaRepo.syncPostMedia(adminContext.db, postId, {
        type: "doc",
        content: [
          { type: "image", attrs: { src: `/images/${mediaKeys[0]}` } },
          { type: "image", attrs: { src: `/images/${mediaKeys[1]}` } },
        ],
      });

      // Batch check
      const linkedKeys = await MediaService.getLinkedMediaKeys(
        adminContext,
        mediaKeys,
      );

      expect(linkedKeys).toHaveLength(2);
      expect(linkedKeys).toContain(mediaKeys[0]);
      expect(linkedKeys).toContain(mediaKeys[1]);
      expect(linkedKeys).not.toContain(mediaKeys[2]);
    });
  });
});
