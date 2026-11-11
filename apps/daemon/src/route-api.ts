// Rename, forget, Wrong, and declined offers. The CLI and the library action use these.

import {
  forgetAbility,
  renameAbility,
  reportWrong,
  type Ability,
  type WrongReport,
} from "@browserkit/site-mapper";
import { rememberDecline } from "./route-memory.js";

export function renameSavedAbility(site: string, from: string, to: string): Promise<Ability> {
  return renameAbility(site, from, to);
}

export function forgetSavedAbility(site: string, name: string): Promise<boolean> {
  return forgetAbility(site, name);
}

export function reportWrongResult(
  report: WrongReport,
): Promise<{ droppedRoute: boolean; stale: boolean }> {
  return reportWrong(report);
}

export function declineOffer(site: string, id: string): Promise<void> {
  return rememberDecline(site, id);
}
