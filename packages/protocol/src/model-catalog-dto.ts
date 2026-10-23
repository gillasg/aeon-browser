import { z } from "zod";

export const PiModelCatalogSchema = z
  .object({
    defaultModel: z
      .object({
        provider: z.string().min(1).max(120),
        id: z.string().min(1).max(300),
        name: z.string().min(1).max(300),
      })
      .strict()
      .nullable(),
    models: z
      .array(
        z
          .object({
            provider: z.string().min(1).max(120),
            id: z.string().min(1).max(300),
            name: z.string().min(1).max(300),
            thinkingLevels: z.array(z.string().min(1).max(40)).max(10),
            defaultThinkingLevel: z.string().min(1).max(40),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type PiModelCatalogDto = z.infer<typeof PiModelCatalogSchema>;
