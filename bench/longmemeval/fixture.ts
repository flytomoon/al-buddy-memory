/**
 * A LongMemEval-shaped instance, written by hand for the tests (the dataset is
 * never committed). Three sessions: filler that opens with an assistant turn,
 * an evidence session where only the first user turn holds the evidence, and
 * a second evidence session with the update.
 */
export function instance(overrides: Record<string, unknown> = {}) {
  return {
    question_id: "q-city",
    question_type: "knowledge-update",
    question: "What city did I move to for work?",
    answer: "Berlin",
    question_date: "2023/06/01 (Thu) 10:00",
    haystack_session_ids: ["filler_a1", "answer_x1_1", "answer_x1_2"],
    haystack_dates: ["2023/01/05 (Thu) 09:00", "2023/02/10 (Fri) 18:30", "2023/05/20 (Sat) 02:21"],
    haystack_sessions: [
      [
        { role: "assistant", content: "Hello! How can I help with baking today?" },
        { role: "user", content: "Can you suggest a sourdough recipe?" },
        { role: "assistant", content: "Mix flour, water and a lively starter, then rest it overnight." },
      ],
      [
        { role: "user", content: "I just moved to Tokyo for work.", has_answer: true },
        { role: "assistant", content: "Congratulations on the move to Tokyo!" },
        { role: "user", content: "Any tips for learning Japanese?", has_answer: false },
        { role: "assistant", content: "Try a daily flashcard habit." },
      ],
      [
        { role: "user", content: "Update: I relocated to Berlin last week.", has_answer: true },
        { role: "assistant", content: "Berlin is a great city for cycling." },
      ],
    ],
    answer_session_ids: ["answer_x1_1", "answer_x1_2"],
    ...overrides,
  };
}
