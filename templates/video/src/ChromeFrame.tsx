import React from "react";
import type { Edit, Rect, RenderProps, Style } from "./types";
import { Scene } from "./Scene";

/**
 * A drawn Chrome window (an opt-in extra, never pretending to be a real capture). Horizontal or
 * vertical tabs, light or dark. The panes are drawn over the chrome in output px so the recording
 * keeps its exact shape and zoom. The tabs and URL come from the edit's own clip titles.
 */
const D = { strip: 42, toolbar: 46, row: 48, side: 168, icons: 56, gap: 10, margin: 10 };

export function palette(style: Style) {
  const dark = style.theme === "dark";
  return {
    window: dark ? "#0b0b0d" : "#f6f6f7",
    chrome: dark ? "#17181b" : "#e9eaee",
    omnibox: dark ? "#2a2b30" : "#ffffff",
    text: dark ? "#e8e8ec" : "#202124",
    dim: dark ? "#9aa0a6" : "#5f6368",
    active: dark ? "#2a2b30" : "#dcdfe5",
    border: dark ? "#3c3c43" : "#c9ccd2",
  };
}

export function frameGeometry(edit: Edit, area: Rect, split: boolean) {
  const vertical = edit.style.frame === "vertical";
  const side = edit.style.frame === "none" ? 0 : vertical ? D.side : 0;
  const top = edit.style.frame === "none" ? 0 : vertical ? D.row : D.strip + D.toolbar;
  const page = edit.source.viewport;
  const H = top + page.height + (split ? D.margin + 30 : 0);
  const panes = (H * area.w) / area.h - side - 2 * D.margin - (split ? D.gap : 0);
  const pageW = split ? Math.max(1, Math.round(panes / 2)) : page.width;
  const W = side + (split ? 2 * D.margin + D.gap + pageW * 2 : page.width);
  const short = Math.min(area.w, area.h);
  const pad = edit.style.padding * short;
  const k = Math.min((area.w - 2 * pad) / W, (area.h - 2 * pad) / H);
  const win: Rect = {
    x: area.x + (area.w - W * k) / 2,
    y: area.y + (area.h - H * k) / 2,
    w: W * k,
    h: H * k,
  };
  return { vertical, split, side, top, k, W, H, win, pageW };
}

type Geo = ReturnType<typeof frameGeometry>;

const Icon: React.FC<{ name: string; size: number; c: string }> = ({ name, size, c }) => {
  const paths: Record<string, string> = {
    back: "M16 10H5M10 4.5 4.5 10 10 15.5",
    forward: "M4 10h11M10 4.5l5.5 5.5-5.5 5.5",
    reload: "M15.5 7.5A6 6 0 1 0 16 11M16 3.5v4h-4",
    puzzle: "M4 7h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3H4v-3a2 2 0 1 0 0-4z",
    star: "M10 3l1.9 4 4.3.5-3.2 3 .9 4.3L10 13.2l-3.9 2.1.9-4.3-3.2-3 4.3-.5z",
    menu: "M10 4.5v.01M10 10v.01M10 15.5v.01",
    plus: "M10 4v12M4 10h12",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: "block", flex: "none" }}>
      <path
        d={paths[name] ?? ""}
        fill="none"
        stroke={c}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const Tab: React.FC<{ label: string; active: boolean; g: Geo; style: Style }> = ({
  label,
  active,
  g,
  style,
}) => {
  const c = palette(style);
  return (
    <div
      style={{
        height: 32,
        maxWidth: g.vertical ? g.side - 16 : 240,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        borderRadius: 8,
        background: active ? c.active : "transparent",
        color: active ? c.text : c.dim,
        fontSize: 13,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: active ? style.accent : c.dim,
          flex: "none",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
};

/** Chrome's toolbar: nav buttons, address bar, extension and profile icons. */
const Toolbar: React.FC<{ g: Geo; style: Style; url: string; active: string }> = ({
  g,
  style,
  url,
  active,
}) => {
  const c = palette(style);
  const barLeft = g.vertical ? g.side : 0;
  const barTop = g.vertical ? 0 : D.strip;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: barLeft,
          top: barTop,
          right: 0,
          height: g.vertical ? D.row : D.toolbar,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
        }}
      >
        {(["back", "forward", "reload"] as const).map((n) => (
          <div
            key={n}
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              opacity: n === "forward" ? 0.5 : 1,
            }}
          >
            <Icon name={n} size={18} c={c.dim} />
          </div>
        ))}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            height: 32,
            borderRadius: 16,
            background: c.omnibox,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            color: c.text,
            fontSize: 13,
            overflow: "hidden",
          }}
        >
          <Icon name="puzzle" size={14} c={c.dim} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {url}
          </span>
          <div style={{ flex: 1 }} />
          <Icon name="star" size={15} c={c.dim} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 4px" }}>
          <Icon name="puzzle" size={18} c={c.dim} />
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: c.dim }} />
          <Icon name="menu" size={18} c={c.dim} />
        </div>
      </div>
      {!g.vertical && !g.split && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 6,
            display: "flex",
            gap: 14,
            color: c.dim,
            fontSize: 14,
          }}
        >
          <span>−</span>
          <span>□</span>
          <span>×</span>
        </div>
      )}
      {active === "side" && null}
    </>
  );
};

export const ChromeFrame: React.FC<{ props: RenderProps; ms: number; st: number; area: Rect }> = ({
  props,
  ms,
  st,
  area,
}) => {
  const { edit } = props;
  const split = !!edit.side;
  const g = frameGeometry(edit, area, split);
  const c = palette(edit.style);
  const { win, k } = g;
  const pagePane: Rect = {
    x: win.x + (g.side + (split ? D.margin : 0)) * k,
    y: win.y + (g.top + (split ? D.margin : 0)) * k,
    w: g.pageW * k,
    h: edit.source.viewport.height * k,
  };
  const sidePane: Rect | undefined = split
    ? { x: pagePane.x + pagePane.w + D.gap * k, y: pagePane.y, w: pagePane.w, h: pagePane.h }
    : undefined;
  const url = edit.source.url
    ? edit.source.url.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "aeon://recording";

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          borderRadius: 12,
          overflow: "hidden",
          background: c.window,
          boxShadow: "0 24px 70px rgba(0,0,0,.35)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: g.W,
            height: g.H,
            transform: `scale(${k})`,
            transformOrigin: "0 0",
            fontFamily: edit.style.font,
            color: c.text,
          }}
        >
          {!g.vertical && (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: g.W,
                height: D.strip,
                background: c.chrome,
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingLeft: 10,
              }}
            >
              <Tab label={split ? "Page" : "Aeon"} active={!split} g={g} style={edit.style} />
              {split && <Tab label={edit.side!.title ?? "Aeon"} active g={g} style={edit.style} />}
              <div
                style={{
                  width: 24,
                  height: 24,
                  display: "grid",
                  placeItems: "center",
                  marginLeft: 4,
                  opacity: 0.7,
                }}
              >
                <Icon name="plus" size={16} c={c.dim} />
              </div>
            </div>
          )}
          {g.vertical && (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: g.side,
                height: g.H,
                background: c.chrome,
                padding: "6px 8px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <Tab label={split ? "Page" : "Aeon"} active={!split} g={g} style={edit.style} />
              {split && <Tab label={edit.side!.title ?? "Aeon"} active g={g} style={edit.style} />}
            </div>
          )}
          <Toolbar g={g} style={edit.style} url={url} active="page" />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `inset(${win.y}px ${area.x + area.w - win.x - win.w}px ${area.y + area.h - win.y - win.h}px ${win.x}px round 12px)`,
        }}
      >
        <Scene props={props} ms={ms} area={pagePane} />
        {sidePane && (
          <Scene
            props={{ ...props, frames: props.edit.side!.frames }}
            ms={ms}
            area={sidePane}
            side
          />
        )}
      </div>
    </>
  );
};

/** Where badges and captions sit relative to the drawn window. */
export function framedLayout(edit: Edit, area: Rect) {
  const g = frameGeometry(edit, area, !!edit.side);
  return { win: g.win, bar: g.top * g.k };
}
