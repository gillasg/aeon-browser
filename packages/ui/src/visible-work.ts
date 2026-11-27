// Continuous work on Graft's pages is only worth doing while someone can see it. The side panel,
// chat tabs and the home page stay mounted (and the eval keeps many chat tabs open), so an
// uncapped 60 fps canvas loop in each one burns a core even when nothing is on screen. Every loop
// in this package goes through these two gates: they stop on visibilitychange and when the element
// leaves the viewport, and they cap the frame rate because our motions turn slowly.

/** rAF loop that paints only while the page is visible and `element` is on screen. */
export function runVisibleFrames(
  element: Element,
  draw: (time: number) => void,
  fps = 20,
): () => void {
  const minGap = 1000 / fps;
  let frame = 0;
  let running = false;
  let onScreen = true;
  let last = -Infinity;

  const loop = (time: number): void => {
    frame = 0;
    if (!running) return;
    // A small tolerance keeps a 20 fps cap from drifting to 10 fps on a 60 Hz display.
    if (time - last >= minGap - 4) {
      last = time;
      draw(time);
    }
    frame = requestAnimationFrame(loop);
  };

  const sync = (): void => {
    const shouldRun = !document.hidden && onScreen;
    if (shouldRun === running) return;
    running = shouldRun;
    if (running) {
      last = -Infinity; // paint promptly on resume instead of replaying skipped frames
      if (!frame) frame = requestAnimationFrame(loop);
    } else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const onVisibility = (): void => sync();
  document.addEventListener("visibilitychange", onVisibility);
  let observer: IntersectionObserver | undefined;
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    observer.observe(element);
  }
  sync(); // No frame is scheduled at all while the document starts out hidden.
  return () => {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("visibilitychange", onVisibility);
    observer?.disconnect();
  };
}

/** Timer that does no polling while the page is hidden. */
export function runVisibleInterval(run: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sync = (): void => {
    if (document.hidden) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      return;
    }
    if (timer === undefined) timer = setInterval(run, ms);
  };
  const onVisibility = (): void => sync();
  document.addEventListener("visibilitychange", onVisibility);
  sync();
  return () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
