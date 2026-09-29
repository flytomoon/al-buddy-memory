# Regenerates fixture-official-metrics.json: random turn-level rankings scored by
# the OFFICIAL LongMemEval retrieval metrics, so the tests can hold metrics.mjs to
# the same numbers. Needs numpy and a LongMemEval checkout:
#
#   python3 bench/longmemeval/official-metrics.py <LongMemEval>/src/retrieval bench/longmemeval/fixture-official-metrics.json
import json, random, sys
import numpy as np

if not hasattr(np, "asfarray"):  # removed in NumPy 2; the official code predates that
    np.asfarray = lambda a: np.asarray(a, dtype=float)
sys.path.insert(0, sys.argv[1])
from eval_utils import evaluate_retrieval, evaluate_retrieval_turn2session

random.seed(7)
cases = []
while len(cases) < 40:
    corpus = []
    for s in range(random.randint(2, 8)):
        answer = random.random() < 0.3
        sid = f"answer_{s:03x}_{s}" if answer else f"filler_{s}"
        for t in range(random.randint(1, 4)):
            tid = f"{sid}_{2 * t + 1}"
            if answer and random.random() < 0.5:
                tid = tid.replace("answer", "noans")
            corpus.append(tid)
    correct = sorted(set(d for d in corpus if "answer" in d))
    if not correct:
        continue
    rankings = list(range(len(corpus)))
    random.shuffle(rankings)
    out = {}
    for k in [1, 3, 5, 10, 30, 50]:
        out[f"turn@{k}"] = [float(x) for x in evaluate_retrieval(rankings, correct, corpus, k=k)]
        out[f"session@{k}"] = [float(x) for x in evaluate_retrieval_turn2session(rankings, correct, corpus, k=k)]
    cases.append({"corpus": corpus, "correct": correct, "ranked": [corpus[i] for i in rankings], "official": out})
with open(sys.argv[2], "w") as f:
    json.dump(cases, f, separators=(",", ":"))
print(len(cases), "cases written to", sys.argv[2])
