export type ManagementSection =
  "routines" | "automations" | "sites" | "resources" | "capabilities" | "settings";
export type ManagementActionName =
  | "create_routine"
  | "update_routine"
  | "run_routine"
  | "delete_routine"
  | "register_capability"
  | "update_capability"
  | "remove_capability"
  | "recheck_capability"
  | "pin_result";
