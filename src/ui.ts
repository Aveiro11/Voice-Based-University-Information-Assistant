import "./style.css";
import { createActor } from "xstate";
import { dmMachine } from "./dm";

document.querySelector("#app")!.innerHTML = `
  <h1>Uni assistant</h1>
  <div class="card">
    <button id="start" type="button">...</button>
    <button id="stop" type="button" disabled>Stop</button>
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
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;
const questionEl = document.querySelector("#question")!;
const answerEl = document.querySelector("#answer")!;
const sourcesEl = document.querySelector("#sources")!;
const logEl = document.querySelector("#log")!;

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
  if (path === lastPath) return;
  lastPath = path;
  const leaf = path.split(".").pop();
  logEl.textContent += `${path}\n`;
  console.log("[state]", path, snap.context);

  if (leaf === "Retrieving") {
    questionEl.textContent = `You: ${snap.context.question}`;
    answerEl.textContent = "";
    sourcesEl.textContent = "";
  }
  if (leaf === "Speaking") {
    answerEl.textContent = snap.context.answer;
    sourcesEl.textContent =
      "sources: " +
      [...new Set(snap.context.chunks.map((c) => c.programmeName))].join(", ");
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
  console.log("ask clicked", JSON.stringify(input.value));
  logEl.textContent += `\n> ${input.value}\n`;
  actor.send({ type: "HEARD", text: input.value });
  input.value = "";
}
document.querySelector("#ask")!.addEventListener("click", ask);
input.addEventListener("keydown", (e) => e.key === "Enter" && ask());