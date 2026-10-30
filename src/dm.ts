import { assign, fromPromise, setup } from "xstate";
import { Settings, speechstate, SpeechStateExternalEvent } from "speechstate";
import { KEY } from "./azure";
import { retrieve, generateAnswer, type Chunk } from "./rag";

const settings: Settings = {
  azureCredentials: {
    endpoint:
      "https://swedencentral.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
    key: KEY,
  },
  azureRegion: "swedencentral",
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 8000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
  bargeIn: false,
};

type Ctx = {
  ssRef: any;
  heard: string; // latest recognised utterance, filled in while listening
  question: string;
  chunks: Chunk[];
  answer: string;
  misses: number; // consecutive turns with no speech
};

// HEARD is only for typing into the text box while debugging
type Ev =
  | { type: "CLICK" }
  | { type: "HEARD"; text: string }
  | SpeechStateExternalEvent;

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
    heardSomething: ({ context }) => context.heard.trim().length > 0,
    tooManyMisses: ({ context }) => context.misses >= 2,
    emptyQuestion: ({ context }) => context.question.length === 0,
  },
  actions: {
    prepare: ({ context }) => context.ssRef.send({ type: "PREPARE" }),
    listen: ({ context }) => context.ssRef.send({ type: "LISTEN" }),
    speak: ({ context }, params: { utterance: string }) =>
      context.ssRef.send({
        type: "SPEAK",
        value: { utterance: params.utterance },
      }),
    logError: ({ event }) => console.error("[DM error]", (event as any).error),
    useSorry: assign({ answer: SORRY }),
  },
}).createMachine({
  id: "DM",
  context: ({ spawn }) => ({
    ssRef: spawn(speechstate, { input: settings }),
    heard: "",
    question: "",
    chunks: [],
    answer: "",
    misses: 0,
  }),
  initial: "Prepare",
  states: {
    Prepare: {
      entry: "prepare",
      on: { ASRTTS_READY: "WaitToStart" },
    },
    // browsers only allow audio after a click, hence the button
    WaitToStart: {
      on: { CLICK: "Greeting" },
    },
    Greeting: {
      entry: {
        type: "speak",
        params: {
          utterance:
            "Hi! Ask me anything about the Master in Language Technology programme.",
        },
      },
      on: { SPEAK_COMPLETE: "Listening" },
    },
    Listening: {
      entry: [assign({ heard: "" }), "listen"],
      on: {
        RECOGNISED: {
          actions: assign({
            heard: ({ event }) => event.value[0]?.utterance ?? "",
          }),
        },
        LISTEN_COMPLETE: [
          {
            guard: "heardSomething",
            target: "Processing",
            actions: assign({
              question: ({ context }) => context.heard.trim(),
              misses: 0,
            }),
          },
          {
            guard: "tooManyMisses",
            target: "WaitToStart",
            actions: assign({ misses: 0 }),
          },
          {
            target: "NoInput",
            actions: assign({ misses: ({ context }) => context.misses + 1 }),
          },
        ],
        HEARD: {
          target: "Processing",
          actions: assign({ question: ({ event }) => event.text.trim() }),
        },
      },
    },
    NoInput: {
      entry: {
        type: "speak",
        params: { utterance: "Sorry, I didn't catch that." },
      },
      on: { SPEAK_COMPLETE: "Listening" },
    },
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
    Speaking: {
      entry: {
        type: "speak",
        params: ({ context }) => ({ utterance: context.answer }),
      },
      on: { SPEAK_COMPLETE: "Listening" },
    },
  },
});