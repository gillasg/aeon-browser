// Solo -> Pair: the browser glides left to 58% and the real terminal emerges on the right, with
// the returned line on the same scanline as the value on the page.
import React from "react";
import { AbsoluteFill } from "remotion";
import { camAt, ease, type Size } from "./camera.ts";
import { Shot } from "./Camera.tsx";
import { pairLayout, scanlinePad } from "./pair.ts";
import { terminalLines } from "./terminal.ts";
import type { DirectorEdit } from "./types.ts";

export const PAIR_EASE_MS = 580;
export const TERM_BG = "#141518";
export const TERM_INK = "#E6E8EC";

export const Pair: React.FC<{ edit: DirectorEdit; base: string; t: number; out: Size }> = ({
  edit,
  base,
  t,
  out,
}) => {
  const pair = edit.pair!;
  const k = ease(Math.max(0, Math.min(1, (t - pair.pairAtMs) / PAIR_EASE_MS)));
  const { browser, terminal } = pairLayout(out, k);
  const vp = { width: browser.w, height: browser.h };
  const font = Math.round(Math.max(out.width, out.height) * 0.0235);
  const lineHeight = Math.round(font * 1.5);
  const src = { width: edit.source.width, height: edit.source.height };
  const lines = edit.terminal ? terminalLines(edit.terminal, t, 40) : [];
  const align =
    pair.alignPageY !== undefined
      ? scanlinePad({
          pageY: pair.alignPageY,
          cam: camAt(edit.cues, t, src, vp, { holds: edit.holds, rest: "stage" }),
          src,
          browser,
          terminal,
          lineHeight,
          line: pair.alignTerminalLine ?? 0,
        })
      : { pad: font, aligned: true };
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: browser.x,
          top: browser.y,
          width: browser.w,
          height: browser.h,
        }}
      >
        <Shot edit={edit} base={base} t={t} viewport={vp} />
      </div>
      {k > 0 ? (
        <div
          style={{
            position: "absolute",
            left: terminal.x,
            top: terminal.y,
            width: terminal.w,
            height: terminal.h,
            backgroundColor: TERM_BG,
            borderRadius: 12,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.07), 0 24px 60px rgba(0,0,0,0.45)",
            opacity: k,
            overflow: "hidden",
            color: TERM_INK,
            font: `400 ${font}px/${lineHeight}px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`,
          }}
        >
          <div style={{ paddingTop: align.pad, paddingLeft: font, paddingRight: font }}>
            {lines.map((line, i) => (
              <div
                key={i}
                style={{
                  height: lineHeight,
                  whiteSpace: "pre",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color:
                    line.kind === "in"
                      ? TERM_INK
                      : line.kind === "err"
                        ? "#E8A0A0"
                        : "rgba(230,232,236,0.78)",
                }}
              >
                {line.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
