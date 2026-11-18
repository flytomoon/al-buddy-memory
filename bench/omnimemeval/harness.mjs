/**
 * OmniMemEval's own harness, at the pinned commit, with our backend added:
 * the client file, its env template and its offline test copied in, and five
 * one-line registrations patched into the places its CONTRIBUTING.md names
 * (registry, the shared search dispatch, LoCoMo's search dispatch and
 * ingestion branch, and the libs that take `chat_time`).
 *
 * Every patch is anchored on text that must occur exactly once at the pinned
 * commit; a moved anchor throws rather than landing in the wrong place, and a
 * patch already applied is left alone, so preparing twice is a no-op.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OMNIMEMEVAL } from "./pin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ADAPTER_DIR = join(HERE, "adapter");

/** Our files, and where they go in the harness. */
export const COPIES = [
  { from: "al_buddy_client.py", to: "scripts/client_factory/al_buddy_client.py" },
  { from: "env.al_buddy", to: "env_examples/.env.al_buddy" },
  { from: "test_al_buddy_client.py", to: "scripts/tests/unit/test_al_buddy_client.py" },
];

const AL_BUDDY_SEARCH = `def al_buddy_search(
    client: Any,
    query: str,
    user_id: str,
    top_k: int,
    *,
    question_date: str | None = None,
    **_kw: Any,
) -> tuple[str, float, None, str]:
    """al-buddy-memory: the question's date goes with the query, so recall reads
    "last week" or "how many" against it (LongMemEval passes it)."""
    start = time()
    results = client.search(query, user_id, top_k, question_date=question_date)
    context, raw_context = format_search_context(results)
    duration_ms = (time() - start) * 1000
    return context, duration_ms, None, raw_context


`;

const LOCOMO_BRANCH = `    # ── al_buddy: one store per conversation, every turn once, as said ───
    # Each turn is "<speaker>: <text>", with a shared photo's description
    # (blip_caption) kept with its message, as the cachly and Hindsight
    # clients do. One search per question (shared_conv_search).
    elif frame == "al_buddy":
        spoken = [c for c in session if c.get("speaker") in (metadata["speaker_a"], metadata["speaker_b"])]
        messages = [
            {**msg, "content": msg["content"] + f" [shares {chat['blip_caption']}]"}
            if chat.get("blip_caption") else msg
            for chat, msg in zip(spoken, speaker_a_messages)
        ]
        inject_time(messages, dt, frame)
        client.add(messages, speaker_a_user_id)

`;

/**
 * `after`: insert `text` right after `anchor`; `before`: right before it;
 * `replace`: put `text` in its place.
 */
export const PATCHES = [
  {
    file: "scripts/client_factory/registry.py",
    kind: "after",
    anchor: `    "cachly":      ("cachly_client",      "CachlyClient"),\n`,
    text: `    "al_buddy":    ("al_buddy_client",    "AlBuddyClient"),\n`,
  },
  {
    file: "scripts/utils/ingest_helpers.py",
    kind: "replace",
    anchor: `"threadatlas", "cachly",\n})`,
    text: `"threadatlas", "cachly",\n    "al_buddy",\n})`,
  },
  { file: "scripts/utils/search_helpers.py", kind: "before", anchor: "# ── Default dispatch table", text: AL_BUDDY_SEARCH },
  { file: "scripts/utils/search_helpers.py", kind: "after", anchor: `    "cachly": generic_text_search,\n`, text: `    "al_buddy": al_buddy_search,\n` },
  { file: "scripts/locomo/locomo_search.py", kind: "after", anchor: `        "cachly": shared_conv_search,\n`, text: `        "al_buddy": shared_conv_search,\n` },
  { file: "scripts/locomo/locomo_ingestion.py", kind: "before", anchor: "    # ── Default: dual-speaker with inject_time", text: LOCOMO_BRANCH },
];

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** What `patch` leaves in a file once applied: the text that proves it is there. */
function appliedForm(patch) {
  if (patch.kind === "after") return patch.anchor + patch.text;
  if (patch.kind === "before") return patch.text + patch.anchor;
  if (patch.kind === "replace") return patch.text;
  throw new Error(`unknown patch kind ${patch.kind}`);
}

/**
 * `content` with `patch` applied, and whether it already was. Throws when
 * the anchor is missing or not unique (the harness is not the pinned commit,
 * or was edited by hand).
 */
export function patchText(content, patch) {
  const applied = appliedForm(patch);
  if (count(content, applied) === 1) return { content, status: "already" };
  const n = count(content, patch.anchor);
  if (n !== 1) throw new Error(`${patch.file}: expected the anchor exactly once, found it ${n} times (is the harness at ${OMNIMEMEVAL.commit.slice(0, 7)}?): ${JSON.stringify(patch.anchor.slice(0, 80))}`);
  const at = content.indexOf(patch.anchor);
  const end = at + patch.anchor.length;
  if (patch.kind === "after") return { content: content.slice(0, end) + patch.text + content.slice(end), status: "applied" };
  if (patch.kind === "before") return { content: content.slice(0, at) + patch.text + content.slice(at), status: "applied" };
  return { content: content.slice(0, at) + patch.text + content.slice(end), status: "applied" };
}

/** The commit `dir`'s checkout is on, read from .git without running git (null when it cannot tell). */
export function checkedOutCommit(dir) {
  const gitDir = join(dir, ".git");
  if (!existsSync(gitDir)) return null;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = join(gitDir, ref);
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  const packed = join(gitDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref) return sha;
  }
  return null;
}

function defaultGit(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

/**
 * Make `dir` OmniMemEval at the pinned commit with our backend added. Clones
 * when `dir` does not exist; moves an existing checkout to the pin (forcing
 * out our own earlier patches, which are re-applied); then copies and
 * patches. Returns what it did, per file.
 */
export function prepareHarness(dir, { git = defaultGit, log = () => {} } = {}) {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    log(`cloning ${OMNIMEMEVAL.repo} into ${dir}`);
    git(["clone", "--quiet", "--no-checkout", OMNIMEMEVAL.repo, dir], dirname(dir));
  }
  if (checkedOutCommit(dir) !== OMNIMEMEVAL.commit) {
    log(`checking out ${OMNIMEMEVAL.commit}`);
    try {
      git(["checkout", "--quiet", "--force", "--detach", OMNIMEMEVAL.commit], dir);
    } catch {
      git(["fetch", "--quiet", "origin", OMNIMEMEVAL.commit], dir);
      git(["checkout", "--quiet", "--force", "--detach", OMNIMEMEVAL.commit], dir);
    }
  }
  const at = checkedOutCommit(dir);
  if (at !== OMNIMEMEVAL.commit) throw new Error(`OmniMemEval in ${dir} is at ${at}, not the pinned ${OMNIMEMEVAL.commit}`);
  const done = [];
  for (const c of COPIES) {
    const to = join(dir, c.to);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ADAPTER_DIR, c.from), to);
    done.push({ file: c.to, status: "copied" });
  }
  // All patches are worked out before any is written, so a moved anchor leaves the tree as it was.
  const files = new Map();
  for (const p of PATCHES) {
    const current = files.get(p.file) ?? readFileSync(join(dir, p.file), "utf8");
    const r = patchText(current, p);
    files.set(p.file, r.content);
    done.push({ file: p.file, status: r.status });
  }
  for (const [file, content] of files) writeFileSync(join(dir, file), content);
  return { commit: at, files: done };
}
