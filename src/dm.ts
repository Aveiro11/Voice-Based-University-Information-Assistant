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
  asrDefaultNoInputTimeout: 6000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
  bargeIn: false,
};

const GREETING =
  "Hi! I can answer questions about the master's programmes in AI, computer science and technology at the University of Gothenburg. What would you like to know?";
const SORRY = "Sorry, something went wrong on my side. Could you ask again?";

type Ctx = {
  ssRef: any;
  heard: string;
  question: string;
  chunks: Chunk[];
  answer: string;
  misses: number; // silent turns in a row
};

type Ev =
  | { type: "CLICK" }
  | { type: "STOP" }
  | { type: "HEARD"; text: string } // debug text box
  | SpeechStateExternalEvent;

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
    // also where Stop and the goodbye end up; browsers need a click for audio
    WaitToStart: {
      id: "idle",
      on: { CLICK: "Active" },
    },
    // everything while the assistant is running. STOP is handled once, here.
    // Outside of Active nothing handles it, so a second click does nothing.
    Active: {
      initial: "Greeting",
      on: { STOP: { target: "#idle", actions: assign({ misses: 0 }) } },
      states: {
        Greeting: {
          entry: { type: "speak", params: { utterance: GREETING } },
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
              { guard: "tooManyMisses", target: "Goodbye" },
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
        // silence: first nudge, then a softer one. misses is already updated here
        NoInput: {
          entry: {
            type: "speak",
            params: ({ context }) => ({
              utterance:
                context.misses === 1
                  ? "Do you have any other questions?"
                  : "I'm still here. Just ask whenever you're ready.",
            }),
          },
          on: { SPEAK_COMPLETE: "Listening" },
        },
        Goodbye: {
          entry: {
            type: "speak",
            params: {
              utterance:
                "I'll stop listening now. Press start when you want to continue.",
            },
          },
          on: {
            SPEAK_COMPLETE: {
              target: "#idle",
              actions: assign({ misses: 0 }),
            },
          },
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
    },
  },
});