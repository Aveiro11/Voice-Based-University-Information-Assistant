import { assign, fromPromise, setup } from "xstate";
import { Settings, speechstate, SpeechStateExternalEvent } from "speechstate";
import { KEY } from "./azure";
import {
  retrieve,
  generateAnswer,
  programmeIn,
  needsProgramme,
  type Chunk,
} from "./rag";

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
  "Hi! I can answer questions about the master's programmes in AI, computer science and technology at the University of Gothenburg.";
const SORRY = "Sorry, something went wrong on my side. Could you ask again?";
const OFFLINE =
  "I can't reach my language model at the moment. Please check the connection and try again.";
const WHICH =
  "Which programme do you mean? For example Computer Science or Logic.";

type Ctx = {
  ssRef: any;
  heard: string;
  question: string;
  chunks: Chunk[];
  answer: string;
  misses: number; // silent turns in a row
  programme: string; // last programme the user mentioned
  pending: string; // question waiting for a programme name
};

type Ev =
  | { type: "CLICK" }
  | { type: "STOP" }
  | { type: "HEARD"; text: string } // debug text box
  | SpeechStateExternalEvent;

// what the user just said, glued to a waiting question if it names a programme
const combined = (c: Ctx) => {
  const heard = c.heard.trim();
  return c.pending && programmeIn(heard) ? `${c.pending} (${heard})` : heard;
};

// the question as the retriever and the LLM should see it: if the user named
// no programme this time, use the one from earlier in the conversation
const forSearch = (c: Ctx) =>
  programmeIn(c.question) || !c.programme
    ? c.question
    : `${c.question} (${c.programme})`;

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
    needsClarify: ({ context }) =>
      !context.programme && needsProgramme(context.question),
  },
  actions: {
    prepare: ({ context }) => context.ssRef.send({ type: "PREPARE" }),
    listen: ({ context }) => context.ssRef.send({ type: "LISTEN" }),
    speak: ({ context }, params: { utterance: string }) =>
      context.ssRef.send({
        type: "SPEAK",
        value: { utterance: params.utterance },
      }),
    stopAudio: ({ context }) => context.ssRef.send({ type: "STOP" }),
    logError: ({ event }) => console.error("[DM error]", (event as any).error),
    // connection problems get their own message, everything else the generic one
    useSorry: assign({
      answer: ({ event }) =>
        /connection|fetch/i.test(String((event as any).error?.message))
          ? OFFLINE
          : SORRY,
    }),
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
    programme: "",
    pending: "",
  }),
  initial: "Prepare",
  states: {
    Prepare: {
      entry: "prepare",
      on: { ASRTTS_READY: "WaitToStart" },
    },
    // need a click before audio; Stop and Goodbye also end up here
    WaitToStart: {
      id: "idle",
      on: {
        CLICK: {
          target: "Active",
          actions: assign({ programme: "", pending: "" }), // fresh conversation
        },
      },
    },
    // STOP is handled once here. Outside Active nothing handles it.
    Active: {
      initial: "Greeting",
      on: {
        STOP: {
          target: "#idle",
          actions: ["stopAudio", assign({ misses: 0, pending: "" })],
        },
      },
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
                  question: ({ context }) => combined(context),
                  programme: ({ context }) =>
                    programmeIn(combined(context)) || context.programme,
                  pending: "",
                  misses: 0,
                }),
              },
              {
                guard: "tooManyMisses",
                target: "Goodbye",
                actions: assign({ pending: "" }),
              },
              {
                target: "NoInput",
                actions: assign({ misses: ({ context }) => context.misses + 1 }),
              },
            ],
            HEARD: {
              target: "Processing",
              actions: assign({
                question: ({ event }) => event.text.trim(),
                programme: ({ context, event }) =>
                  programmeIn(event.text) || context.programme,
                pending: "",
              }),
            },
          },
        },
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
            { guard: "needsClarify", target: "Clarify" },
            { target: "Retrieving" },
          ],
        },
        // the question needs a programme and none is known: ask, keep the
        // question, and listen again. Listening glues the answer onto it.
        Clarify: {
          entry: [
            assign({ pending: ({ context }) => context.question }),
            { type: "speak", params: { utterance: WHICH } },
          ],
          on: { SPEAK_COMPLETE: "Listening" },
        },
        Retrieving: {
          invoke: {
            src: "retrieve",
            input: ({ context }) => ({ question: forSearch(context) }),
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
              question: forSearch(context),
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