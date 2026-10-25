import { z } from "zod";
import { ChatIdSchema } from "./chat-dto.js";

const RequestIdSchema = z.string().uuid();

export const ManagementGetRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.get"),
    payload: z.object({ chatId: ChatIdSchema.optional() }).strict(),
  })
  .strict();

export const ManagementHomeRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.home"),
    payload: z.object({}).strict(),
  })
  .strict();

export const ManagementActionRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.action"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        action: z.enum([
          "create_routine",
          "update_routine",
          "run_routine",
          "delete_routine",
          "register_capability",
          "update_capability",
          "remove_capability",
          "recheck_capability",
          "pin_result",
          "run_workflow",
          "cancel_workflow",
          "import_workflow",
          "export_workflow",
          "run_site_operation",
          "run_site_recipe",
          "export_site",
          "import_site",
          "export_recipes",
          "import_recipes",
          "clear_site_session",
          "switch_site_account",
          "test_site_logged_out",
          "record_workflow_from_run",
          "start_site_recording",
          "stop_site_recording",
          "check_providers",
          "test_provider",
        ]),
        input: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();
