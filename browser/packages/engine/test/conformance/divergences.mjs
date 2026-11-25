// Known divergences between what Aeon's engine does today and what the sweep expects. Each pin
// names one failing leaf exactly: {scenario, step, pointer} plus its kind ('Bug' for an engine
// bug to fix, 'Unsupported' for something the engine deliberately does not do), the behaviour
// the sweep expects and a note. A pin only tolerates that exact failure, and a pin that no
// longer fails is stale and fails the sweep, so a fix lands together with removing its pin.
// pointer "" is the step's own expectation; any other pointer is a leaf of its golden record.
// A race that fails on some runs only is pinned with `intermittent: true` and pointer "*": it
// covers that whole step and is never reported stale, so its fix needs repeated green runs.

export const TESTED_WITH = "Chrome for Testing 157.0.8103.78";

export const divergences = [];
