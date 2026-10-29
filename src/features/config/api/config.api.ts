import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseSiteAssetUploadInput } from "@/features/config/config.asset.schema";
import { SystemConfigSchema } from "@/features/config/config.schema";
import * as ConfigService from "@/features/config/service/config.service";
import { adminMiddleware } from "@/lib/middlewares";
import { m } from "@/paraglide/messages";

export const getSystemConfigFn = createServerFn()
  .middleware([adminMiddleware])
  .handler(({ context }) => ConfigService.getSystemConfigAdmin(context));

export const updateSystemConfigFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      config: SystemConfigSchema,
      expectedVersion: z.number().int().nonnegative().optional(),
    }),
  )
  .handler(({ context, data }) =>
    ConfigService.updateSystemConfig(context, data.config, {
      expectedVersion: data.expectedVersion,
    }),
  );

const SiteAssetUploadInputSchema = z.instanceof(FormData);

export const uploadSiteAssetFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(SiteAssetUploadInputSchema)
  .handler(async ({ data, context }) => {
    const input = parseSiteAssetUploadInput(data, m);
    return ConfigService.uploadSiteAsset(context, input);
  });
