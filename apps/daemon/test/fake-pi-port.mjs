export class FakePiPort {
  constructor() {
    this.opens = [];
    this.creations = 0;
    this.prompts = [];
    this.handles = new Map();
    this.waitForSubmit = undefined;
    this.queued = { steering: [], followUp: [] };
  }

  async openOrCreate(input) {
    this.opens.push(input);
    let handle = this.handles.get(input.chatId);
    if (!handle) {
      this.creations += 1;
      const reference = input.reference ?? {
        sessionId: input.activationId,
        sessionFile: `C:/temp-pi/${input.activationId}.jsonl`,
      };
      handle = {
        reference,
        submit: async (message) => {
          this.prompts.push({ chatId: input.chatId, text: message.text });
          if (this.waitForSubmit) await this.waitForSubmit;
        },
        queue: async (message, mode) => {
          const key = mode === "steer" ? "steering" : "followUp";
          this.queued[key].push(message.text);
          this.prompts.push({ chatId: input.chatId, text: message.text, mode });
        },
        abort: async () => {},
        controls: () => ({
          effectiveModel: null,
          availableModels: [],
          thinkingLevel: "off",
          availableThinkingLevels: [],
          steeringQueue: [...this.queued.steering],
          followUpQueue: [...this.queued.followUp],
          active: Boolean(this.waitForSubmit),
        }),
        setModel: async () => {},
        setThinkingLevel: () => {},
        snapshot: () => ({
          reference,
          workingDirectory: input.workingDirectory,
          entries: [],
          materialized: false,
          active: false,
        }),
        subscribe: () => () => {},
        close: () => {},
      };
      this.handles.set(input.chatId, handle);
    }
    return handle;
  }

  async searchTranscript() {
    return undefined;
  }
}
