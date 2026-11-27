// The real-Chrome conformance sweep as one test: every scenario through Graft's real bridge,
// extension and engine, judged against the golden transcripts and the pinned divergences.
// Chrome comes from CHROME_PATH or the pinned Chrome for Testing; GRAFT_CONFORMANCE_REQUIRE=chrome
// turns a missing Chrome into a failure instead of a skip.
import assert from "node:assert/strict";
import test from "node:test";
import { runSweep, skipReason } from "./sweep.mjs";

const skip = skipReason();

test(
  "conformance sweep matches its golden transcripts and pinned divergences",
  { skip },
  async () => {
    const { verdict, ms } = await runSweep();
    assert.deepEqual(
      verdict.problems,
      [],
      `${verdict.problems.length} conformance problem(s) in ${ms} ms; see the lines above`,
    );
  },
);
