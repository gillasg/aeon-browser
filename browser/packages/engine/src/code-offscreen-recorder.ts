// The recorder behind page.recordVideo, in the offscreen document (MediaRecorder and tab capture
// need a document). A tab-capture recording encodes the tab's own stream, its sound included and
// still audible to the user; a screencast recording draws DevTools frames onto a canvas and
// encodes that. The finished video stays here until the service worker reads it in slices.

interface Recording {
  recorder?: MediaRecorder;
  stream?: MediaStream;
  chunks: Blob[];
  blob?: Blob;
  mimeType: string;
  fps: number;
  canvas?: HTMLCanvasElement;
  audio?: AudioContext;
  screencast?: Screencast;
  /** Wall-clock ms when the encoder started (tab capture), to line a take's trace up with the video. */
  startedWall?: number;
}

// A screencast recording places every frame at the moment the page captured it, not when it
// arrived here: frames decode one at a time, in order, and are drawn on a fixed delay behind
// capture time, so a slow decode never reorders or bunches them. A frame that cannot be placed
// (it arrived later than the delay allows, or decoding failed) is counted as lost, and a
// recording that lost any frame fails rather than producing a choppy video.
interface Screencast {
  chain: Promise<void>;
  /** The first frame's capture time and the moment it is drawn; later frames keep that spacing. */
  origin?: { capture: number; wall: number };
  lastCapture: number;
  received: number;
  drawn: number;
  lost: number;
  /** Capture time of the last frame kept for decoding. */
  lastAccepted: number;
  /** Frames received and not yet drawn or dropped. */
  waiting: number;
  /** Why frames were lost, for the failure message: reordered, late (and by how much), undecodable. */
  reordered: number;
  late: number;
  worstLateMs: number;
  track?: CanvasCaptureMediaStreamTrack;
}
const PLACEMENT_DELAY_MS = 1000;
const recordings = new Map<number, Recording>();

type Message = Record<string, unknown> & { kind: string; tabId: number };

export function recordingMessage(message: Message): Promise<unknown> | undefined {
  if (message.kind === "recordStart") return start(message);
  if (message.kind === "recordFrame")
    return frame(message.tabId, String(message.data ?? ""), Number(message.capturedAt));
  if (message.kind === "recordStop") return stop(message.tabId);
  if (message.kind === "recordRead")
    return read(message.tabId, Number(message.offset), Number(message.size));
  if (message.kind === "recordDrop") return Promise.resolve(drop(message.tabId));
  return undefined;
}

function pickType(format: unknown, audio: boolean): string {
  const mp4 = audio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4"];
  const webm = audio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm"];
  const order = format === "webm" ? [...webm, ...mp4] : [...mp4, ...webm];
  return order.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function start(message: Message): Promise<unknown> {
  drop(message.tabId);
  const fps = Number(message.fps) || 30;
  const audio = message.audio === true && message.canvas !== true;
  const recording: Recording = { chunks: [], mimeType: pickType(message.format, audio), fps };
  try {
    if (message.canvas === true) {
      // The size comes from the first frame; the recorder starts then.
      recording.canvas = document.createElement("canvas");
      recording.screencast = {
        chain: Promise.resolve(),
        lastCapture: 0,
        received: 0,
        drawn: 0,
        lost: 0,
        waiting: 0,
        lastAccepted: 0,
        reordered: 0,
        late: 0,
        worstLateMs: 0,
      };
      recordings.set(message.tabId, recording);
      return { ok: true, mimeType: recording.mimeType };
    }
    const source = { chromeMediaSource: "tab", chromeMediaSourceId: String(message.streamId) };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audio ? { mandatory: source } : false,
      video: { mandatory: { ...source, maxFrameRate: fps, maxWidth: 1920, maxHeight: 1080 } },
    } as MediaStreamConstraints);
    if (audio) {
      // Capturing a tab's sound mutes it for the user; play it back so they still hear it.
      recording.audio = new AudioContext();
      recording.audio.createMediaStreamSource(stream).connect(recording.audio.destination);
    }
    recordings.set(message.tabId, recording);
    await begin(recording, stream);
    return { ok: true, mimeType: recording.recorder?.mimeType || recording.mimeType };
  } catch (error) {
    drop(message.tabId);
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

function begin(recording: Recording, stream: MediaStream): Promise<void> {
  recording.stream = stream;
  const recorder = new MediaRecorder(stream, {
    ...(recording.mimeType ? { mimeType: recording.mimeType } : {}),
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 128_000,
  });
  recording.recorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size) recording.chunks.push(event.data);
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MediaRecorder did not start")), 5000);
    recorder.onstart = () => {
      recording.startedWall = Date.now();
      clearTimeout(timer);
      resolve();
    };
    recorder.start(1000);
  });
}

/** capturedAt: the frame's capture time in seconds (Page.screencastFrame metadata.timestamp). */
function frame(tabId: number, data: string, capturedAt: number): Promise<unknown> {
  const recording = recordings.get(tabId);
  const cast = recording?.screencast;
  if (!recording || !cast || !data) return Promise.resolve(false);
  cast.received++;
  // Chrome can send 100+ frames a second; a video needs one per frame slot. The rest are skipped
  // before decoding: that is the frame rate, not a loss.
  const captureMs = capturedAt * 1000;
  if (captureMs > 0 && captureMs - cast.lastAccepted < 1000 / recording.fps - 1)
    return Promise.resolve(false);
  if (captureMs > 0) cast.lastAccepted = captureMs;
  // Frames wait compressed and decode only when their turn comes, so a fast page never piles up
  // full-size pictures in memory; a queue longer than two seconds of video is already a failure.
  if (cast.waiting >= recording.fps * 2) {
    cast.lost++;
    cast.late++;
    return Promise.resolve(false);
  }
  cast.waiting++;
  const jpeg = new Blob([fromBase64(data)], { type: "image/jpeg" });
  cast.chain = cast.chain
    .then(() => place(recording, cast, createImageBitmap(jpeg), capturedAt))
    .finally(() => cast.waiting--);
  return Promise.resolve(true);
}

// Native base64 decoding: a character-by-character copy takes ~15 ms a frame, enough on its own
// for two tabs at 30 fps to fall behind.
const nativeBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array })
  .fromBase64;
function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  if (nativeBase64) return nativeBase64.call(Uint8Array, data) as Uint8Array<ArrayBuffer>;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function place(
  recording: Recording,
  cast: Screencast,
  decoded: Promise<ImageBitmap>,
  capturedAt: number,
): Promise<void> {
  const image = await decoded.catch(() => undefined);
  const canvas = recording.canvas;
  if (!image || !canvas) {
    cast.lost++;
    return;
  }
  const captureMs = Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt * 1000 : Date.now();
  const origin = cast.origin ?? (await startCanvas(recording, cast, canvas, image, captureMs));
  const wait = origin.wall + (captureMs - origin.capture) - performance.now();
  // Timer jitter under one frame is invisible; only a frame that misses its slot by more is lost.
  const tolerance = 1000 / recording.fps;
  if (captureMs < cast.lastCapture || wait < -tolerance) {
    image.close();
    cast.lost++;
    if (captureMs < cast.lastCapture) cast.reordered++;
    else {
      cast.late++;
      cast.worstLateMs = Math.max(cast.worstLateMs, Math.round(-wait));
    }
    return;
  }
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  cast.lastCapture = captureMs;
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  cast.track?.requestFrame();
  cast.drawn++;
  image.close();
}

/** The first frame sizes the canvas and starts the encoder; frames are then pushed one by one. */
async function startCanvas(
  recording: Recording,
  cast: Screencast,
  canvas: HTMLCanvasElement,
  image: ImageBitmap,
  captureMs: number,
): Promise<{ capture: number; wall: number }> {
  canvas.width = image.width - (image.width % 2);
  canvas.height = image.height - (image.height % 2);
  const stream = canvas.captureStream(0);
  cast.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  // MediaRecorder reports started only once the track has a frame: give it the first one.
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const started = begin(recording, stream);
  cast.track.requestFrame();
  await started;
  cast.origin = { capture: captureMs, wall: performance.now() + PLACEMENT_DELAY_MS };
  return cast.origin;
}

/** Holds the last picture until the recording's real end, so the video is as long as the take. */
async function settle(cast: Screencast): Promise<void> {
  await cast.chain;
  cast.track?.requestFrame();
}

async function stop(tabId: number): Promise<unknown> {
  const recording = recordings.get(tabId);
  if (!recording) return { ok: false, error: "no recording" };
  const recorder = recording.recorder;
  if (!recorder) {
    drop(tabId);
    return {
      ok: false,
      error:
        "no frames: Chrome only paints visible windows; keep the tab's window open and unminimized",
    };
  }
  const cast = recording.screencast;
  if (cast) await settle(cast);
  await finishRecorder(recording, recorder);
  const frames = cast && {
    received: cast.received,
    drawn: cast.drawn,
    lost: cast.lost,
    reordered: cast.reordered,
    late: cast.late,
    worstLateMs: cast.worstLateMs,
  };
  if (cast?.lost) {
    drop(tabId);
    return {
      ok: false,
      error: `${cast.lost} of ${cast.received} frames could not be placed on time (${cast.reordered} out of order, ${cast.late} late by up to ${cast.worstLateMs} ms), so the video would stutter; record again (fewer tabs at once, or a smaller window)`,
      frames,
    };
  }
  const mimeType = recorder.mimeType || recording.mimeType || "video/webm";
  recording.blob = new Blob(recording.chunks, { type: mimeType });
  recording.chunks = [];
  return {
    ok: true,
    bytes: recording.blob.size,
    mimeType,
    ...(frames ? { frames } : {}),
    ...clipTiming(recording),
  };
}

/** When the clip's first frame was captured (epoch ms) and its size: a take aligns its trace to it. */
function clipTiming(recording: Recording): Record<string, number | undefined> {
  const canvas = recording.canvas;
  const track = recording.stream?.getVideoTracks()[0]?.getSettings();
  return {
    firstFrameAt: recording.screencast?.origin?.capture ?? recording.startedWall,
    width: canvas?.width ?? track?.width,
    height: canvas?.height ?? track?.height,
  };
}

async function finishRecorder(recording: Recording, recorder: MediaRecorder): Promise<void> {
  if (recorder.state !== "inactive")
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
  void recording.audio?.close().catch(() => undefined);
}

async function read(tabId: number, offset: number, size: number): Promise<unknown> {
  const blob = recordings.get(tabId)?.blob;
  if (!blob) return { base64: "", done: true };
  const slice = blob.slice(offset, offset + size);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(slice);
  });
  return { base64, done: offset + size >= blob.size };
}

function drop(tabId: number): boolean {
  const recording = recordings.get(tabId);
  if (!recording) return false;
  if (recording.recorder && recording.recorder.state !== "inactive") recording.recorder.stop();
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
  void recording.audio?.close().catch(() => undefined);
  recordings.delete(tabId);
  return true;
}
