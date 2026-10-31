import {
  browserkitHome,
  readProfile,
  removeProfileField,
  saveProfileValues,
} from "@browserkit/tools/host";

// Settings → Forms: the user's own view of the form profile bu.fillProfile() fills from. It is
// the one copy in browserkit's data folder; the agent only ever sees the field names.

export interface FormProfileChange {
  action: "read" | "save" | "remove";
  field?: string | undefined;
  value?: string | undefined;
}

export async function applyFormProfile(change: FormProfileChange): Promise<{
  kind: "settings.form-profile";
  fields: { name: string; value: string }[];
  refused?: string;
}> {
  const home = browserkitHome();
  let refused: string | undefined;
  if (change.action === "save" && change.field) {
    const kept = await saveProfileValues(home, { [change.field]: change.value ?? "" });
    refused = kept.refused[0]?.reason;
  }
  if (change.action === "remove" && change.field) await removeProfileField(home, change.field);
  const profile = await readProfile(home);
  return {
    kind: "settings.form-profile",
    fields: Object.entries(profile).map(([name, value]) => ({ name, value })),
    ...(refused ? { refused } : {}),
  };
}
