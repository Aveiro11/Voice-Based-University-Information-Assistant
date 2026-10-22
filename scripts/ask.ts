import { retrieve, generateAnswer } from "../src/rag.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('usage: npm run ask -- "your question"');
  process.exit(1);
}

const chunks = await retrieve(question);
console.log("retrieved:", chunks.map((c) => `p${c.page}:${c.score.toFixed(2)}`).join("  "));
console.log("\n" + (await generateAnswer(question, chunks)));