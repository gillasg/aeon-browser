// The staged take (src/recording.json, copied from events.json) at the scene's output fps.
import json from "./recording.json";
import { loadRecording } from "./recording.ts";

export const OUTPUT_FPS = 60;
export const take = loadRecording(json, { fps: OUTPUT_FPS });
