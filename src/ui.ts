import "./style.css";
import { createActor } from "xstate";
import { dmMachine } from "./dm";

document.querySelector("#app")!.innerHTML = `
  <h1>Uni assistant</h1>
  <div class="card">
    <input id="q" type="text" size="50" placeholder="Ask about the programme..." />
    <button id="ask" type="button">Ask</button>
  </div>
  <p id="answer"></p>
  <p id="sources"></p>
  <pre id="log"></pre>
`;

const input = document.querySelector<HTMLInputElement>("#q")!;
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
  if (state === "Speaking") {
    answerEl.textContent = snap.context.answer;
    sourcesEl.textContent =
      "sources: " + snap.context.chunks.map((c) => `p${c.page}`).join(", ");
  }
});
actor.start();

function ask() {
  logEl.textContent += `\n> ${input.value}\n`;
  actor.send({ type: "HEARD", text: input.value });
  input.value = "";
}
document.querySelector("#ask")!.addEventListener("click", ask);
input.addEventListener("keydown", (e) => e.key === "Enter" && ask());