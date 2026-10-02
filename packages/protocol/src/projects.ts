import { z } from "zod";
export const ProjectSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    folders: z.array(z.string().min(1).max(4096)).min(1).max(10),
    createdAt: z.string(),
  })
  .strict();
const base = { kind: z.literal("command"), requestId: z.string().uuid() };
export const ProjectListRequestSchema = z
  .object({ ...base, operation: z.literal("project.list"), payload: z.object({}).strict() })
  .strict();
export const ProjectCreateRequestSchema = z
  .object({
    ...base,
    operation: z.literal("project.create"),
    payload: z
      .object({
        name: z.string().trim().min(1).max(120),
        folders: z.array(z.string().min(1).max(4096)).max(1),
      })
      .strict(),
  })
  .strict();
export const ProjectPickRequestSchema = z
  .object({ ...base, operation: z.literal("project.pick-folder"), payload: z.object({}).strict() })
  .strict();
export const ProjectListResultSchema = z
  .object({ kind: z.literal("project.list"), projects: z.array(ProjectSchema).max(500) })
  .strict();
export const ProjectCreateResultSchema = z
  .object({ kind: z.literal("project.created"), project: ProjectSchema })
  .strict();
export const ProjectPickResultSchema = z
  .object({ kind: z.literal("project.folder"), path: z.string().nullable() })
  .strict();
export type ProjectDto = z.infer<typeof ProjectSchema>;

export const ProjectUpdateRequestSchema = z
  .object({
    ...base,
    operation: z.literal("project.update"),
    payload: z
      .object({
        projectId: z.string().uuid(),
        name: z.string().trim().min(1).max(120),
        folders: z.array(z.string().min(1).max(4096)).min(1).max(1),
      })
      .strict(),
  })
  .strict();
export const ProjectUpdateResultSchema = z
  .object({ kind: z.literal("project.updated"), project: ProjectSchema })
  .strict();
