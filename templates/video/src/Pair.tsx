// Solo -> Pair: the browser glides left to 58% and the real terminal emerges on the right, with
// the returned line on the same scanline as the value on the page, joined by one dotted row.
import React from "react";
import { AbsoluteFill } from "remotion";
import { camAt, ease, viewTransform, type Size } from "./camera.ts";
import { Shot } from "./Camera.tsx";
import { DotScanline } from "./DotMatrix.tsx";
import { INK } from "./dotmatrix.ts";
import { pairCam, pairLayout, paneFont, scanlinePad } from "./pair.ts";
import { terminalLines } from "./terminal.ts";
import type { DirectorEdit } from "./types.ts";

export const PAIR_EASE_MS = 580;
export const TERM_BG = INK.void;
export const TERM_INK = INK.primary;

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
  const src = { width: edit.source.width, height: edit.source.height };
  const lines = edit.terminal ? terminalLines(edit.terminal, t, 40) : [];
  const final = edit.terminal ? terminalLines(edit.terminal, Infinity, 40) : lines;
  const font = paneFont(out, terminal.w, final);
  const lineHeight = Math.round(font * 1.5);
  const cam = pairCam(camAt(edit.cues, t, src, vp, { holds: edit.holds, rest: "stage" }), src, vp);
  const vt = viewTransform(cam, src, vp);
  // The connector leaves from the window's right edge, never across the page it shows.
  const windowRight = browser.x + Math.min(browser.w, vt.x + src.width * vt.scale);
  const align =
    pair.alignPageY !== undefined
      ? scanlinePad({
          pageY: pair.alignPageY,
          cam,
          src,
          browser,
          terminal,
          lineHeight,
          line: pair.alignTerminalLine ?? 0,
        })
      : { pad: font, aligned: false, y: 0 };
  // The connector waits for the glide to land, then draws left to right in 420 ms.
  const draw = Math.max(0, Math.min(1, (t - pair.pairAtMs - PAIR_EASE_MS) / 420));
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
        <Shot edit={edit} base={base} t={t} viewport={vp} keepLeft />
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
            boxShadow: `inset 0 1px 0 ${INK.rimTop}, inset 0 0 0 1px ${INK.hairline}`,
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
                  color:
                    line.kind === "in"
                      ? TERM_INK
                      : line.kind === "err"
                        ? INK.muted
                        : "rgba(243,243,241,0.78)",
                }}
              >
                {line.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {align.aligned && draw > 0 ? (
        <DotScanline
          x0={windowRight + font * 0.4}
          x1={terminal.x + font * 0.6}
          y={align.y}
          k={draw}
        />
      ) : null}
    </AbsoluteFill>
  );
};
