// The mystery engine: loads one case's mystery file and keeps track of the player's
// progress through it. It does no drawing (walkthrough.js does that), so the rules of
// the game live in one place:
//   - the steps run in the order the case file lists them
//   - a "choice" step is done once the player has picked the correct option
//   - a "graph" step is done once every hidden node has been predicted correctly
//   - the player can't go forward until the current step is done
//   - the verdict uses the case's numbers file ONLY if results.json lists it;
//     otherwise there are no numbers at all, and the verdict says "evidence pending"
//
// Numbers file format (written by the processing scripts, Stage 2):
//   { "measured": [ { "label", "value", "unit", "note" } ],
//     "check":    { "label", "text" },
//     "badge":    "text", "generated": "date", "sources": [ "file names" ] }

export async function loadMystery(caseInfo) {
  const data = await fetch(caseInfo.mysteryFile).then((r) => r.json());
  const numbers = caseInfo.numbersPath
    ? await fetch(caseInfo.numbersPath).then((r) => r.json())
    : null;
  return new Mystery(caseInfo, data, numbers);
}

class Mystery {
  constructor(info, data, numbers) {
    this.info = info;            // from cases/index.json (+ passes)
    this.data = data;            // from cases/<id>.json
    this.numbers = numbers;      // from cases/<id>.numbers.json, or null
    this.stepIndex = 0;
    this.solved = new Set();     // 'choice:<id>' and 'node:<id>' once answered correctly
    this.tried = new Set();      // wrong options already tried, e.g. 'choice:method:0'
  }

  get steps() { return this.data.steps; }
  get step() { return this.steps[this.stepIndex]; }
  get isLast() { return this.stepIndex === this.steps.length - 1; }

  hiddenNodes() { return this.data.graph.nodes.filter((n) => n.hidden); }

  isStepDone(step = this.step) {
    if (step.type === 'choice') return this.solved.has(`choice:${step.choice}`);
    if (step.type === 'graph') return this.hiddenNodes().every((n) => this.solved.has(`node:${n.id}`));
    return true;   // reading steps are done as soon as you've seen them
  }

  // Player picks option i of a choice. Returns that option (with its own reply).
  answerChoice(choiceId, i) {
    const option = this.data.choices[choiceId].options[i];
    if (option.correct) this.solved.add(`choice:${choiceId}`);
    else this.tried.add(`choice:${choiceId}:${i}`);
    return option;
  }

  // Player predicts a hidden node in the cause-and-effect graph.
  answerNode(nodeId, i) {
    const node = this.data.graph.nodes.find((n) => n.id === nodeId);
    const option = node.options[i];
    if (option.correct) this.solved.add(`node:${nodeId}`);
    else this.tried.add(`node:${nodeId}:${i}`);
    return option;
  }

  next() {
    if (this.isStepDone() && !this.isLast) this.stepIndex++;
  }

  back() {
    if (this.stepIndex > 0) this.stepIndex--;
  }
}
