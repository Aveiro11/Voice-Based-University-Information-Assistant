import "./style.css";
import { createActor } from "xstate";
import { dmMachine } from "./dm";

// friendly names for the states shown in the status pill
const LABELS: Record<string, string> = {
  Prepare: "Getting ready",
  WaitToStart: "Stopped, press Start",
  Greeting: "Greeting you",
  Listening: "Listening",
  NoInput: "Waiting for you",
  Goodbye: "Saying goodbye",
  Processing: "Checking the question",
  Clarify: "Asking which programme",
  Retrieving: "Searching the programmes",
  GeneratingAnswer: "Writing the answer",
  Speaking: "Speaking",
};
const BUSY = new Set(["Processing", "Clarify", "Retrieving", "GeneratingAnswer"]);
const SPEAKING = new Set(["Greeting", "NoInput", "Goodbye", "Speaking"]);

document.querySelector("#app")!.innerHTML = `
  <header>
    <h1>Uni assistant</h1>
    <p class="sub">Ask about the master's programmes in AI, computer science and technology at the University of Gothenburg.</p>
  </header>

  <div class="controls">
    <button id="start" class="btn primary" type="button">...</button>
    <button id="stop" class="btn" type="button" disabled>Stop</button>
    <div id="status" class="pill" data-state="idle">
      <span class="dot"></span><span id="statusText">Getting ready</span>
    </div>
  </div>

  <section class="convo">
    <p class="who">You</p>
    <p id="question" class="q"></p>
    <p class="who">Assistant</p>
    <p id="answer" class="a"></p>
    <div id="sources" class="chips"></div>
  </section>

  <details>
    <summary>Debug tools</summary>
    <div class="debug">
      <div class="row">
        <input id="q" type="text" placeholder="type a question instead of speaking" />
        <button id="ask" class="btn" type="button">Ask</button>
      </div>
      <pre id="log"></pre>
    </div>
  </details>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const input = $<HTMLInputElement>("#q");
const startBtn = $<HTMLButtonElement>("#start");
const stopBtn = $<HTMLButtonElement>("#stop");
const statusEl = $("#status");
const statusText = $("#statusText");
const questionEl = $("#question");
const answerEl = $("#answer");
const sourcesEl = $("#sources");
const logEl = $("#log");

// {Active: "Listening"} -> "Active.Listening"
const flat = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Object.entries(v as object)
        .map(([k, c]) => `${k}.${flat(c)}`)
        .join(",");

const actor = createActor(dmMachine);

let lastPath = "";
actor.subscribe((snap) => {
  const active = snap.matches("Active");
  stopBtn.disabled = !active;
  startBtn.disabled = active;

  const path = flat(snap.value);
  const leaf = path.split(".").pop()!;
  statusText.textContent = LABELS[leaf] ?? leaf;
  statusEl.dataset.state =
    leaf === "Listening"
      ? "listening"
      : BUSY.has(leaf)
        ? "busy"
        : SPEAKING.has(leaf)
          ? "speaking"
          : "idle";

  if (path === lastPath) return;
  lastPath = path;
  logEl.textContent += `${path}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log("[state]", path, snap.context);

  if (leaf === "Retrieving") {
    questionEl.textContent = snap.context.question;
    answerEl.textContent = "";
    sourcesEl.innerHTML = "";
  }
  if (leaf === "Speaking") {
    answerEl.textContent = snap.context.answer;
    const names = [...new Set(snap.context.chunks.map((c) => c.programmeName))];
    sourcesEl.innerHTML = names.map((n) => `<span class="chip">${n}</span>`).join("");
  }
});
actor.start();

startBtn.addEventListener("click", () => actor.send({ type: "CLICK" }));
stopBtn.addEventListener("click", () => actor.send({ type: "STOP" }));

// the label on the start button comes from speechstate itself
actor.getSnapshot().context.ssRef.subscribe((snap: any) => {
  const meta: any = Object.values(snap.getMeta())[0];
  if (meta?.view) startBtn.innerHTML = meta.view;
});

function ask() {
  logEl.textContent += `\n> ${input.value}\n`;
  actor.send({ type: "HEARD", text: input.value });
  input.value = "";
}
$("#ask").addEventListener("click", ask);
input.addEventListener("keydown", (e) => e.key === "Enter" && ask());