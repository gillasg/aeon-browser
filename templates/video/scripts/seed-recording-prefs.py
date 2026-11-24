#!/usr/bin/env python3
# Seeds the recording profile's Preferences: usage seed-recording-prefs.py <Preferences> <ext dir> <ext id>.
import json, os, sys
pref, ext_dir, ext_id = sys.argv[1:4]
d = json.load(open(pref)) if os.path.exists(pref) else {}
settings = d.setdefault("extensions", {}).setdefault("settings", {})
manifest = json.load(open(os.path.join(ext_dir, "manifest.json")))
perms = {
    "api": manifest.get("permissions", []),
    "explicit_host": manifest.get("host_permissions", []),
    "scriptable_host": manifest.get("host_permissions", []),
}
if ext_id not in settings:
    settings[ext_id] = {
        "location": 4, "state": 1,
        "from_webstore": False, "was_installed_by_default": False,
        "was_installed_by_oem": False, "creation_flags": 38,
        "active_permissions": perms, "granted_permissions": perms,
        "content_settings": [], "incognito_content_settings": [],
        "incognito_preferences": {}, "preferences": {},
        "regular_only_preferences": {}, "withholding_permissions": False,
    }
# Always point at THIS build: an entry left by an older run (another worktree) otherwise loads a
# stale extension silently.
entry = settings[ext_id]
entry.update(path=ext_dir, manifest=manifest, state=1)
entry["active_permissions"] = entry["granted_permissions"] = perms
d["extensions"].setdefault("ui", {})["developer_mode"] = True
d.setdefault("browser", {})["has_seen_welcome_page"] = True
# The system frame (undecorated by the window manager below): no caption buttons in the tab strip.
d["browser"]["custom_chrome_frame"] = False
# Alt+Shift+Space summons the cursor box; seed the binding when nothing holds it yet.
commands = d["extensions"].setdefault("commands", {})
old_key = "linux:Ctrl+Shift+Space"
if commands.get(old_key, {}).get("command_name") == "summon-orb":
    del commands[old_key]
key = "linux:Alt+Shift+Space"
if key not in commands:
    commands[key] = {"command_name": "summon-orb", "extension": ext_id, "global": False}
# Chrome 157 draws a New Tab Page footer ("Aeon" + "Customize Chrome") under extension pages.
d.setdefault("ntp_footer", {}).setdefault("settings", {}).update(
    extension_attribution=False, management_notice=False)
# A killed Chrome leaves exit_type "Crashed", and the next start films a "Restore pages?" bubble.
d.setdefault("profile", {}).update(exit_type="Normal", exited_cleanly=True)
# Saved tab groups are pinned to the bookmarks bar, which then films ~40 px of chips ("Aeon1a2b3c4d",
# old prompts) above every frame. Hide the bar and never auto-pin a group.
d.setdefault("bookmark_bar", {})["show_on_all_tabs"] = False
d.setdefault("tab_groups", {})["auto_pin_new_tab_groups"] = False
d.setdefault("saved_tab_groups", {})["auto_pin_new_tab_groups"] = False
# English UI and New Tab Page, whatever the host locale.
intl = d.setdefault("intl", {})
intl["accept_languages"] = "en-US,en"
intl["selected_languages"] = "en-US,en"
intl["app_locale"] = "en-US"
d.setdefault("translate", {})["enabled"] = False
with open(pref, "w") as f: json.dump(d, f, separators=(",", ":"))
