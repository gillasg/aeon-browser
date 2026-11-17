## Video demos: record, then render with Remotion

Aeon records; it ships no renderer. `aeon record start [--window chrome|--screen|--tabs] [--out dir]` then `aeon record stop` write a folder: frames, `clip.mp4` and `events.json` (every click, type, scroll, navigation and tab switch, with position and time). `aeon video kit <dir>` copies a Remotion starter kit with a README example: 16:9, 9:16 or square; a Chrome frame with horizontal or vertical tabs, light or dark; captions, title and end cards, a "sped up N×" badge, a code wallpaper; which tab shows when.

House style: clean, readable on a phone. Honesty rule: zooms, speed-ups and the cursor come only from `events.json`; never show Aeon doing what it did not do; every speed-up carries its badge. See `help('video')`.
