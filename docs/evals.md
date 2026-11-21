# How Aeon is measured

Aeon is checked against a private eval suite before each release. This page reports the latest run as it came out, including what failed.

## How grading works

- **Tasks run on local copies of real sites** (shops, inboxes, forms, ticket pages), served from a fixture server. The same task gives the same page every time.
- **Graded on the outcome, not on what the agent says.** Each task has a check script that reads the fixture's own log or the final page: whether the order was placed, whether the field holds the right value, when the watcher first asked for the page. If the agent claims success without the state to match, the task fails.
- **Harness errors are counted separately.** If the fixture server goes down or the grader crashes, the task is rerun once and then left out of the pass rate, so those failures aren't blamed on the agent.
- **Every run records cost and time** at the model's list price, from the provider's token counts.
- **The bot-detector suite runs on a home connection** against the public detector pages, and is decided from what each page showed.

## Latest results: Grok 4.7, thinking high, 21 Nov 2026

### Lane A: 23 everyday tasks

**18/23 passed (78%, 95% CI 58–90%).** Cost $0.93 at list price for all 23. Wall time 39 min, running 2 at a time.

Failures:

| Task | What happened |
| --- | --- |
| i8: grab tickets when they open | It created a watcher, but then waited inside the chat and deleted the watcher. The task needs the first request within 3 s of the sale opening. |
| i6: buy as soon as a drop opens | It waited inside the chat instead of creating a watcher. |
| i2: tell me when the price drops | It created a 5-minute watcher, but the price flipped before the first check. |
| Two tasks over budget | They finished correctly but went over their step or minute budget, so they count as not passed. |

All three real failures come from one cause. For timing-critical watches, the agent doesn't yet pick a fast, model-free watcher on its own. That's the next fix. The same three tasks fail on DeepSeek V4.1 Flash too, so the cause is in Aeon's guidance, not the model.

### Bot detectors

| Detector | Result |
| --- | --- |
| BrowserScan | pass |
| CreepJS | pass |
| Cloudflare | pass |
| DataDome | pass |
| HUMAN (PerimeterX) | pass |
| Fingerprint (bot detection) | pass |
| Sannysoft | fail: WebGL vendor and renderer, because the test server has no GPU |
| Pixelscan | undecided: the page reports the proxy the test uses |

### First-tool choice

115 situations × 3 repeats. Each one checks whether the agent's first tool call is the right kind: for example, a routine for "tell me when", an ability for a saved task, a crawl for a whole site.

**43% right on the first call, 49% within 3 steps.** On DeepSeek V4.1 Flash the same suite scores 35% and 39%. The weakest area is watchers (0 of 14 on both models): the agent reads the page before creating the routine. That's the same gap Lane A shows.

## Hill-climb log

Each change to Aeon's guidance or tools is measured against the suite before it is kept.

| Date | Change | Measured on | Before | After | Kept? |
| --- | --- | --- | --- | --- | --- |
| 21 Nov 2026 | Watchers: create the routine within two steps and end the turn; set the interval from how fast the condition changes | First-tool choice, 14 watcher situations ×3, Grok 4.7 | 0/14 within 3 steps | 5/14 within 3 steps (still 0/14 on the first call) | Yes; first-call gap still open |

## Earlier runs (DeepSeek V4.1 Flash, thinking high)

| Date | Lane A | First-tool choice |
| --- | --- | --- |
| 19 Nov 2026 | 15–16/23 | 35% |
| 18 Nov 2026 | 17/23 | not run |
