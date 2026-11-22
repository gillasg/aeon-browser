# Benchmarks

Model-free benches for Aeon's browser layer and install. Each writes its results under `results/`.

| Bench       | What it measures                                                         | Run                               |
| ----------- | ------------------------------------------------------------------------ | --------------------------------- |
| `kernel`    | speed and steadiness of eight everyday browser jobs through `aeon repl`  | `node benchmarks/kernel/run.mjs`  |
| `chaos`     | concurrent sessions, tab leaks and hung-cell timeouts in your Chrome     | `node benchmarks/chaos/run.mjs`   |
| `stealth`   | what bot detectors see when Aeon drives your Chrome                      | `node benchmarks/stealth/run.mjs` |
| `installed` | the installed native host through sleep/resume, dropped links and update | `pnpm bench:installed`            |

`kernel`, `chaos` and `stealth` drive the real Chrome. Their offline pieces are unit-tested by
`benchmarks/*.test.mjs` as part of `pnpm test`.
