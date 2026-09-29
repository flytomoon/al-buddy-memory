import { describe, expect, it } from "vitest";
import { analyzeQuery, inWindows, keywordsOf, WINDOW_SLACK_DAYS, type TimeWindow } from "./query-cues.js";

/** Tuesday 30 May 2023, 23:45 UTC — a LongMemEval question date. */
const NOW = "2023-05-30T23:45:00.000Z";
const DAY = 86_400_000;
/** The window a period resolves to: its own [from, to) widened by the documented slack. */
const slack = (from: string, to: string) => ({
  from: new Date(Date.parse(from) - WINDOW_SLACK_DAYS.before * DAY).toISOString(),
  to: new Date(Date.parse(to) + WINDOW_SLACK_DAYS.after * DAY).toISOString(),
});
const window = (query: string, now = NOW): Omit<TimeWindow, "phrase"> & { phrase?: string } => {
  const w = analyzeQuery(query, { now }).windows;
  expect(w).toHaveLength(1);
  return w[0]!;
};

describe("analyzeQuery — periods, resolved against the moment the question is asked", () => {
  it("rolling periods end now and reach back the number of units named", () => {
    expect(window("How many times did I bake something in the past two weeks?")).toMatchObject({ ...slack("2023-05-16T23:45:00.000Z", NOW), phrase: "in the past two weeks" });
    expect(window("How many plants did I acquire in the last month?")).toMatchObject(slack("2023-04-30T23:45:00.000Z", NOW));
    expect(window("What did I spend in the past few months?")).toMatchObject(slack("2023-02-28T23:45:00.000Z", NOW));
    expect(window("How many MCU films did I watch in the last 3 months?")).toMatchObject(slack("2023-02-28T23:45:00.000Z", NOW));
  });

  it("'last week' is the calendar week before this one and the days since; 'this year' is from 1 January", () => {
    // Monday 22 May is the start of the week before Tuesday 30 May.
    expect(window("How many hours of jogging did I do last week?")).toMatchObject(slack("2023-05-22T00:00:00.000Z", NOW));
    expect(window("What did I buy last month?")).toMatchObject(slack("2023-04-01T00:00:00.000Z", NOW));
    expect(window("How many weddings have I attended in this year?", "2023-10-15T23:47:00.000Z")).toMatchObject(slack("2023-01-01T00:00:00.000Z", "2023-10-15T23:47:00.000Z"));
    expect(window("How much have I spent since the start of the year?")).toMatchObject(slack("2023-01-01T00:00:00.000Z", NOW));
  });

  it("a month name is the latest such month that has begun, so December asked in March is last year's", () => {
    expect(window("How many doctor's appointments did I go to in March?")).toMatchObject(slack("2023-03-01T00:00:00.000Z", "2023-04-01T00:00:00.000Z"));
    expect(window("How many museums did I visit in December?", "2023-03-03T23:44:00.000Z")).toMatchObject(slack("2022-12-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"));
    expect(window("What did I do in the month of February?")).toMatchObject(slack("2023-02-01T00:00:00.000Z", "2023-03-01T00:00:00.000Z"));
    expect(window("How many rollercoasters did I ride from July to October?", "2023-11-04T00:00:00.000Z")).toMatchObject(slack("2023-07-01T00:00:00.000Z", "2023-11-01T00:00:00.000Z"));
    // "since" runs to now.
    expect(window("How many books have I read since March?")).toMatchObject(slack("2023-03-01T00:00:00.000Z", NOW));
  });

  it("days: a date, 'the 7/22 trip', 'last Thursday', 'yesterday', 'two weeks ago'", () => {
    expect(window("How many days ago did I read the March 15th issue?")).toMatchObject(slack("2023-03-15T00:00:00.000Z", "2023-03-16T00:00:00.000Z"));
    expect(window("What did I catch before the 7/22 trip?", "2023-12-06T00:00:00.000Z")).toMatchObject(slack("2023-07-22T00:00:00.000Z", "2023-07-23T00:00:00.000Z"));
    expect(window("What happened on 2023/04/02?")).toMatchObject(slack("2023-04-02T00:00:00.000Z", "2023-04-03T00:00:00.000Z"));
    // The Thursday before Tuesday 30 May is the 25th.
    expect(window("How much cashback did I earn at SaveMart last Thursday?")).toMatchObject(slack("2023-05-25T00:00:00.000Z", "2023-05-26T00:00:00.000Z"));
    expect(window("What did I eat yesterday?")).toMatchObject(slack("2023-05-29T00:00:00.000Z", "2023-05-30T00:00:00.000Z"));
    expect(window("Which book did I finish two weeks ago?")).toMatchObject(slack("2023-05-09T23:45:00.000Z", "2023-05-23T23:45:00.000Z"));
  });

  it("words that only look like periods are left alone", () => {
    for (const q of [
      "May I ask what my favourite colour is?",
      "What time do I wake up on Saturday mornings?",
      "How many days ago did I attend the Maundy Thursday service?",
      "How much flour is 1/2 cup?",
      "What is the order of airlines I flew with before today?",
      "How much faster did I finish the 5K compared to my previous year's time?",
      "Can you recommend a show to watch tonight?",
      "What should I cook this weekend?",
      "How many weeks ago did I start using Ibotta?",
    ]) {
      expect(analyzeQuery(q, { now: NOW }).windows, q).toEqual([]);
    }
  });

  it("the query without its time words is kept for searching; none when it had none", () => {
    expect(analyzeQuery("How many times did I bake something in the past two weeks?", { now: NOW }).withoutTime).toBe("How many times did I bake something?");
    expect(analyzeQuery("How many weddings have I attended in this year?", { now: NOW }).withoutTime).toBe("How many weddings have I attended?");
    expect(analyzeQuery("How many projects have I led?", { now: NOW }).withoutTime).toBeNull();
  });

  it("two periods are two windows", () => {
    const w = analyzeQuery("What was the page count of the novels I finished in January and in March?", { now: NOW }).windows;
    expect(w.map((x) => x.phrase)).toEqual(["in January", "in March"]);
  });

  it("is deterministic, and refuses a `now` that is not an instant — a time with no zone included, since its week depends on the machine", () => {
    const q = "How many hours of jogging and yoga did I do last week?";
    expect(analyzeQuery(q, { now: NOW })).toEqual(analyzeQuery(q, { now: new Date(NOW) }));
    expect(() => analyzeQuery(q, { now: "next tuesday" })).toThrow(/now must be an ISO 8601 instant/);
    expect(() => analyzeQuery(q, { now: "2023-05-30T23:45:00" })).toThrow(/now must be an ISO 8601 instant/);
  });

  it("a sentence may open with the preposition: 'Since March, …', 'From July to October, …', 'In May, …', 'Before March, …'", () => {
    expect(window("Since March, how many books have I read?")).toMatchObject(slack("2023-03-01T00:00:00.000Z", NOW));
    expect(window("From July to October, how many rollercoasters did I ride?", "2023-11-04T00:00:00.000Z")).toMatchObject(slack("2023-07-01T00:00:00.000Z", "2023-11-01T00:00:00.000Z"));
    expect(window("In May, how many times did I bake?")).toMatchObject(slack("2023-05-01T00:00:00.000Z", "2023-06-01T00:00:00.000Z"));
    expect(analyzeQuery("Before March, where did I live?", { now: NOW }).windows).toEqual([]);
  });

  it("a range is the one begun most recently, runs across New Year, and keeps a year it is given", () => {
    expect(window("What did I read from May to July?", "2023-06-10T00:00:00.000Z")).toMatchObject(slack("2023-05-01T00:00:00.000Z", "2023-08-01T00:00:00.000Z"));
    expect(window("What did I read from November to February?", "2023-03-10T00:00:00.000Z")).toMatchObject(slack("2022-11-01T00:00:00.000Z", "2023-03-01T00:00:00.000Z"));
    expect(window("What did I read from March 2022 to May?", "2023-06-01T00:00:00.000Z")).toMatchObject(slack("2022-03-01T00:00:00.000Z", "2022-06-01T00:00:00.000Z"));
  });

  it("'last May' asked in May is a year ago; a day that does not exist is no day; 'the last day of my trip' is not a period", () => {
    expect(window("What did I plant last May?", "2023-05-20T00:00:00.000Z")).toMatchObject(slack("2022-05-01T00:00:00.000Z", "2022-06-01T00:00:00.000Z"));
    // "February 30" is no day, so it is read as the month it names — not rolled over to 2 March.
    expect(window("What happened on February 30?")).toMatchObject(slack("2023-02-01T00:00:00.000Z", "2023-03-01T00:00:00.000Z"));
    expect(analyzeQuery("What happened on 2/30?", { now: NOW }).windows).toEqual([]);
    expect(analyzeQuery("What did I eat on the last day of my trip?", { now: NOW }).windows).toEqual([]);
  });
});

describe("analyzeQuery — counting, now, first and last", () => {
  it("marks questions that count, total, compare or order across memories", () => {
    for (const q of [
      "How many items of clothing do I need to pick up or return?",
      "What is the total amount I spent on luxury items?",
      "Which event happened first, my cousin's wedding or Michael's engagement party?",
      "How much more did I spend on accommodations in Hawaii compared to Tokyo?",
      "What is the order of the three trips I took?",
      "What is the average age of me, my parents, and my grandparents?",
      "Which grocery store did I spend the most money at?",
    ]) {
      expect(analyzeQuery(q, { now: NOW }).aggregation, q).toBe(true);
    }
    for (const q of ["What is my favourite colour?", "Where did I go on my honeymoon?", "What did I order at the restaurant?"]) {
      expect(analyzeQuery(q, { now: NOW }).aggregation, q).toBe(false);
    }
    // A period's number is not a count: "two weeks" goes with the period.
    expect(analyzeQuery("What did I bake in the past two weeks?", { now: NOW }).aggregation).toBe(false);
  });

  it("'currently' and 'most recently' ask for the latest; 'initially' for the earliest; both at once for neither", () => {
    expect(analyzeQuery("How many bikes do I currently own?", { now: NOW })).toMatchObject({ current: true, order: "latest" });
    expect(analyzeQuery("What type of camera lens did I purchase most recently?", { now: NOW })).toMatchObject({ order: "latest" });
    expect(analyzeQuery("Where did I go on my last trip?", { now: NOW })).toMatchObject({ order: "latest" });
    expect(analyzeQuery("How many plants did I initially plant for tomatoes?", { now: NOW })).toMatchObject({ order: "earliest" });
    expect(analyzeQuery("How many engineers did I lead at first, and how many do I lead now?", { now: NOW }).order).toBeNull();
  });

  it("pointing back at a conversation is not asking for the earliest or latest of anything", () => {
    for (const q of [
      "I'm checking our previous chat about the shift rotation. What was the rotation on a Sunday?",
      "Can you remind me of the hostel you recommended last time?",
      "What was my last name before I changed it?",
    ]) {
      expect(analyzeQuery(q, { now: NOW }).order, q).toBeNull();
    }
  });
});

describe("analyzeQuery — one sub-query per thing the question names together", () => {
  it("splits a coordination, and a one-word part borrows the head it shares", () => {
    expect(analyzeQuery("How many hours of jogging and yoga did I do last week?", { now: NOW }).parts).toEqual(["How many hours of jogging", "yoga did I do hours"]);
    expect(analyzeQuery("How much did I spend on car wash and parking ticket?", { now: NOW }).parts).toEqual(["How much did I spend on car wash", "parking ticket"]);
    expect(analyzeQuery("Which event happened first, my cousin's wedding or Michael's engagement party?", { now: NOW }).parts).toEqual([
      "Which event happened first",
      "my cousin's wedding",
      "Michael's engagement party",
    ]);
  });

  it("a quoted title is one thing, even with 'and' or a comma inside", () => {
    expect(analyzeQuery("How long did I spend on 'Pride and Prejudice' and 'War, Peace'?", { now: NOW }).parts).toEqual([
      'How long did I spend on "Pride and Prejudice"',
      '"War, Peace"',
    ]);
  });

  it("names nothing together, no parts — and a thousands comma is not a list", () => {
    expect(analyzeQuery("How many projects have I led?", { now: NOW }).parts).toEqual([]);
    expect(analyzeQuery("Did I save 1,000 dollars?", { now: NOW }).parts).toEqual([]);
  });
});

describe("keywordsOf and inWindows", () => {
  it("keeps what a question is about, in order", () => {
    expect(keywordsOf("How many times did I bake egg tarts?")).toBe("bake egg tarts");
    expect(keywordsOf("How many did I?")).toBe("");
  });

  it("an instant is in a window from its start up to, not including, its end", () => {
    const w = [{ from: "2023-05-01T00:00:00.000Z", to: "2023-06-01T00:00:00.000Z", phrase: "in May" }];
    expect(inWindows("2023-05-01T00:00:00.000Z", w)).toBe(true);
    expect(inWindows("2023-06-01T00:00:00.000Z", w)).toBe(false);
    expect(inWindows("not a date", w)).toBe(false);
  });
});
