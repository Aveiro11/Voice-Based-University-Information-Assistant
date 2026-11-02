import { retrieve } from "../src/rag.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('usage: npm run search -- "your question"');
  process.exit(1);
}

for (const c of await retrieve(question)) {
  const where = c.page ? `, page ${c.page}` : "";
  console.log(`\n[${c.score.toFixed(3)}] ${c.programmeName} / ${c.sourceType}${where}`);
  console.log(c.text);
}