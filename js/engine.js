// The mystery engine: loads one case's mystery file and keeps track of the player's
// progress through it. It does no drawing (walkthrough.js does that), so the rules of
// the game live in one place:
//   - the steps run in the order the case file lists them
//   - a "choice" step is done once the player has picked the correct option
//   - an "evidence" step (the sorting game) is done once every card that has real evidence is
//     filed correctly (and, for a trap, named correctly); cards still pending are not in the game
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
    if (step.type === 'evidence') return this.sortableCards().every((c) => this.isCardSolved(c.id));
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

  // ---------- evidence-sorting game ----------
  // A card is in the game only if its evidence exists (an image or a data file) and isn't pending.
  sortableCards() {
    return this.data.evidence.filter((e) => !e.pending && e.src && (e.bin === 'real' || e.bin === 'trap'));
  }

  isCardSolved(id) { return this.solved.has(`card:${id}`); }

  // Player files card `id` in bin 'real' or 'trap'; for a trap, trapId is the trap they named
  // (null while they haven't named it yet). Score = cards filed right on the first attempt.
  answerCard(id, bin, trapId) {
    const card = this.data.evidence.find((e) => e.id === id);
    const binRight = card.bin === bin;
    const correct = binRight && (bin === 'real' || trapId === card.trap);
    if (correct) this.solved.add(`card:${id}`);
    else this.tried.add(`card:${id}`);
    return { correct, binRight };
  }

  cardScore() {
    const cards = this.sortableCards();
    return {
      total: cards.length,
      filed: cards.filter((c) => this.isCardSolved(c.id)).length,
      firstTry: cards.filter((c) => this.isCardSolved(c.id) && !this.tried.has(`card:${c.id}`)).length,
    };
  }

  next() {
    if (this.isStepDone() && !this.isLast) this.stepIndex++;
  }

  back() {
    if (this.stepIndex > 0) this.stepIndex--;
  }
}
