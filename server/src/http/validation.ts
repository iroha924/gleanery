import { z } from "zod";

export const positiveId = z.coerce.number().int().positive();
export const positiveIds = z.array(z.number().int().positive()).max(100);

export const idParamSchema = z.object({ id: positiveId });
export const textIdParamSchema = z.object({ id: z.string().trim().min(1).max(500) });
export const uuidParamSchema = z.object({ id: z.uuid() });

const commaSeparatedIds = z
  .string()
  .regex(/^\d+(,\d+)*$/)
  .transform((value) => value.split(",").map(Number))
  .pipe(positiveIds);

export const scopesQuerySchema = z.object({ scopes: commaSeparatedIds.optional() });
