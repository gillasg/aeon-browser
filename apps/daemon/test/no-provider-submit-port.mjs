export function createNoProviderSubmitPort(adapter) {
  const openedReferences = [];
  const submissions = [];
  return {
    openedReferences,
    submissions,
    port: {
      openOrCreate: async (input) => {
        const session = await adapter.openOrCreate(input);
        openedReferences.push(session.reference);
        return {
          reference: session.reference,
          submit: async (message) => {
            submissions.push({ chatId: input.chatId, text: message.text });
          },
          queue: (message, mode) => session.queue(message, mode),
          abort: () => session.abort(),
          controls: () => session.controls(),
          setModel: (provider, id) => session.setModel(provider, id),
          setThinkingLevel: (level) => session.setThinkingLevel(level),
          snapshot: () => session.snapshot(),
          subscribe: (listener) => session.subscribe(listener),
          close: () => session.close(),
        };
      },
    },
  };
}
