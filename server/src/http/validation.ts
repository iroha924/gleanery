import { z } from "zod";

export const positiveId = z.coerce.number().int().positive();
export const positiveIds = z.array(z.number().int().positive()).max(20);
export const uuidParamSchema = z.object({ id: z.uuid() });
