import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  assertMediaKey,
  GetMediaListInputSchema,
  MediaKeyInputSchema,
  parseUploadMediaInput,
  UpdateMediaNameInputSchema,
  UploadMediaInputSchema,
} from "@/features/media/media.schema";
import * as MediaService from "@/features/media/service/media.service";
import { adminMiddleware } from "@/lib/middlewares";
import { m } from "@/paraglide/messages";

export const uploadImageFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(UploadMediaInputSchema)
  .handler(({ data, context }) =>
    MediaService.upload(context, parseUploadMediaInput(data, m)),
  );

export const deleteImageFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(MediaKeyInputSchema)
  .handler(({ data, context }) =>
    MediaService.deleteImage(context, assertMediaKey(data.key, m)),
  );

export const getMediaFn = createServerFn()
  .middleware([adminMiddleware])
  .inputValidator(GetMediaListInputSchema)
  .handler(({ data, context }) => MediaService.getMediaList(context, data));

export const getLinkedPostsFn = createServerFn()
  .middleware([adminMiddleware])
  .inputValidator(MediaKeyInputSchema)
  .handler(({ data, context }) =>
    MediaService.getLinkedPosts(context, assertMediaKey(data.key, m)),
  );

export const getLinkedMediaKeysFn = createServerFn()
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      keys: z.array(z.string().min(1).max(200)).max(100),
    }),
  )
  .handler(({ data, context }) =>
    MediaService.getLinkedMediaKeys(context, data.keys),
  );

export const getTotalMediaSizeFn = createServerFn()
  .middleware([adminMiddleware])
  .handler(({ context }) => MediaService.getTotalMediaSize(context));

export const updateMediaNameFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(UpdateMediaNameInputSchema)
  .handler(({ data, context }) => MediaService.updateMediaName(context, data));

export const cleanupUnusedMediaFn = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({ limit: z.number().int().min(1).max(500).optional() }),
  )
  .handler(({ data, context }) =>
    MediaService.cleanupUnusedMedia(context, data),
  );
