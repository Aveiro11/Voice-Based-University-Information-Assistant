import { assign, fromPromise, raise, setup } from "xstate";
import { retrieve, generateAnswer, type Chunk } from "./rag";

type Ctx = { question: string; chunks: Chunk[]; answer: string };
type Ev = { type: "HEARD"; text: string } | { type: "SPEAK_COMPLETE" };

const SORRY = "Sorry, something went wrong on my side. Could you ask again?";

export const dmMachine = setup({
  types: {} as { context: Ctx; events: Ev },
  actors: {
    retrieve: fromPromise(({ input }: { input: { question: string } }) =>
      retrieve(input.question),
    ),
    generate: fromPromise(
      ({ input }: { input: { question: string; chunks: Chunk[] } }) =>
        generateAnswer(input.question, input.chunks),
    ),
  },
  guards: {
    emptyQuestion: ({ context }) => context.question.length === 0,
  },
  actions: {
    logError: ({ event }) => console.error("[DM error]", (event as any).error),
    useSorry: assign({ answer: SORRY }),
  },
}).createMachine({
  id: "DM",
  context: { question: "", chunks: [], answer: "" },
  initial: "Listening",
  states: {
    Listening: {
      on: {
        HEARD: {
          target: "Processing",
          actions: assign({ question: ({ event }) => event.text.trim() }),
        },
      },
    },
    // nothing was recognised -> go back to listening
    Processing: {
      always: [
        { guard: "emptyQuestion", target: "Listening" },
        { target: "Retrieving" },
      ],
    },
    Retrieving: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ question: context.question }),
        onDone: {
          target: "GeneratingAnswer",
          actions: assign({ chunks: ({ event }) => event.output }),
        },
        onError: { target: "Speaking", actions: ["logError", "useSorry"] },
      },
    },
    GeneratingAnswer: {
      invoke: {
        src: "generate",
        input: ({ context }) => ({
          question: context.question,
          chunks: context.chunks,
        }),
        onDone: {
          target: "Speaking",
          actions: assign({ answer: ({ event }) => event.output }),
        },
        onError: { target: "Speaking", actions: ["logError", "useSorry"] },
      },
    },
    // placeholder: Stage 5 swaps this entry action for a SpeechState SPEAK
    Speaking: {
      entry: raise({ type: "SPEAK_COMPLETE" }, { delay: 300 }),
      on: { SPEAK_COMPLETE: "Listening" },
    },
  },
});