// Frames between the extension and the local process that hosts browser_code realms. They ride
// the extension's existing socket; nothing about them is chrome- or Node-specific.

/** Extension to local process: one realm operation (cell, job, interrupt, reset, stopJobs). */
export const REALM_OP = "browser.realm.op";
/** Local process to extension: the operation's answer. */
export const REALM_OP_REPLY = "browser.realm.op.reply";
/** Local process to extension: a realm event (call, stage, jobDone, jobLost). */
export const REALM_EVENT = "browser.realm.event";
/** Extension to local process: the event's answer. */
export const REALM_EVENT_REPLY = "browser.realm.event.reply";
