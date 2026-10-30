import "./style.css";
import { createActor } from "xstate";
import { dmMachine } from "./dm";

document.querySelector("#app")!.innerHTML = `
  <h1>Uni assistant</h1>
  <div class="card">
    <button id="start" type="button">...</button>
  </div>
  <div class="card">
    <input id="q" type="text" size="50" placeholder="(debug) type a question..." />
    <button id="ask" type="button">Ask</button>
  </div>
  <p id="question"></p>
  <p id="answer"></p>
  <p id="sources"></p>
  <pre id="log"></pre>
`;

const input = document.querySelector<HTMLInputElement>("#q")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const questionEl = document.querySelector("#question")!;
const answerEl = document.querySelector("#answer")!;
const sourcesEl = document.querySelector("#sources")!;
const logEl = document.querySelector("#log")!;

const actor = createActor(dmMachine);

let lastState = "";
actor.subscribe((snap) => {
  const state = String(snap.value);
  if (state === lastState) return;
  lastState = state;
  logEl.textContent += `${state}\n`;
  console.log("[state]", state, snap.context);
  if (state === "Retrieving") {
    questionEl.textContent = `You: ${snap.context.question}`;
    answerEl.textContent = "";
    sourcesEl.textContent = "";
  }
  if (state === "Speaking") {
    answerEl.textContent = snap.context.answer;
    sourcesEl.textContent =
      "sources: " + snap.context.chunks.map((c) => `p${c.page}`).join(", ");
  }
});
actor.start();

startBtn.addEventListener("click", () => actor.send({ type: "CLICK" }));
actor.getSnapshot().context.ssRef.subscribe((snap: any) => {
  const meta: any = Object.values(snap.getMeta())[0];
  if (meta?.view) startBtn.innerHTML = meta.view;
});

function ask() {
  console.log("ask clicked", JSON.stringify(input.value));
  logEl.textContent += `\n> ${input.value}\n`;
  actor.send({ type: "HEARD", text: input.value });
  input.value = "";
}
document.querySelector("#ask")!.addEventListener("click", ask);
input.addEventListener("keydown", (e) => e.key === "Enter" && ask());