/**
 * Captions, and scene boundaries, derived from the word timings that were bought.
 *
 * Both of these are arithmetic, and the agent kept being asked to do them by
 * hand. It wrote a caption system from scratch on every run and guessed scene
 * boundaries by dividing the runtime evenly, which puts a cut in the middle of a
 * sentence whenever one line is longer than another.
 *
 * The transcript already says exactly when every word is spoken. So the cues and
 * the boundaries are computed here, once, and the composition is handed the
 * answer. Nothing about this needs judgement and nothing about it varies by
 * brief.
 */

/** Words may come back as {text,start,end} or {word,start,end}. Accept both. */
const wordOf = (w) => String(w.text ?? w.word ?? "").trim();
const startOf = (w) => Number(w.start ?? w.start_time ?? 0);
const endOf = (w) => Number(w.end ?? w.end_time ?? startOf(w));

/**
 * Group words into caption phrases.
 *
 * Three to seven words. Fewer strobes, more becomes a subtitle track that sits
 * still while the narrator moves. Sentence-ending punctuation always closes a
 * phrase, because breaking across a full stop reads as a mistake however well
 * the timing lines up.
 */
export function cuesFrom(words, { min = 3, max = 7, gapBreak = 0.45 } = {}) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    cues.push({
      text: current.map(wordOf).join(" "),
      start: startOf(current[0]),
      end: endOf(current[current.length - 1]),
      words: current.map((w) => ({ text: wordOf(w), start: startOf(w), end: endOf(w) })),
    });
    current = [];
  };

  for (const [i, w] of words.entries()) {
    current.push(w);
    const text = wordOf(w);
    const next = words[i + 1];
    const sentenceEnd = /[.!?]$/.test(text);
    // A real pause in delivery is a better break than any word count.
    const bigGap = next && startOf(next) - endOf(w) > gapBreak;

    if (current.length >= max || (current.length >= min && (sentenceEnd || bigGap)) || sentenceEnd) {
      flush();
    }
  }
  flush();
  return cues;
}

/**
 * Where each scene starts and ends, from what is actually said in it.
 *
 * Each narration line belongs to one scene, so a scene runs from the first word
 * of its line to the last. Dividing the runtime evenly instead, which is the
 * obvious thing to do without a transcript, cuts away from a narrator mid
 * sentence whenever one line is longer than the others.
 *
 * Falls back to proportional division when the words cannot be matched, because
 * a slightly wrong boundary is better than no composition.
 */
export function sceneTimes(words, narration, total) {
  const counts = narration.map((line) => String(line).trim().split(/\s+/).filter(Boolean).length);
  const wanted = counts.reduce((a, b) => a + b, 0);

  if (!words?.length || wanted === 0 || words.length < wanted * 0.6) {
    // Proportional to how much each line has to say, which is at least better
    // than equal slices.
    const per = total / (wanted || narration.length || 1);
    let at = 0;
    return counts.map((n) => {
      const start = at;
      const duration = (n || 1) * per;
      at += duration;
      return { start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)) };
    });
  }

  const times = [];
  let index = 0;
  let at = 0;
  for (const [i, n] of counts.entries()) {
    const last = Math.min(index + n - 1, words.length - 1);
    const isFinal = i === counts.length - 1;
    const end = isFinal ? total : endOf(words[last]);
    times.push({
      start: Number(at.toFixed(2)),
      duration: Number(Math.max(0.5, end - at).toFixed(2)),
    });
    at = end;
    index += n;
  }
  return times;
}

/**
 * Emit the caption layer as a file the composition just includes.
 *
 * Cues are baked in rather than parsed at runtime: the renderer seeks the same
 * frame many times, and re-deriving the track on every seek is both wasted work
 * and a chance for it to come out differently.
 */
export function captionsJs(cues) {
  const data = JSON.stringify(cues.map((c) => ({ t: c.text, s: c.start, e: c.end })), null, 2);
  return `/**
 * The caption track, generated from the word timings bought for this job.
 *
 * Regenerate rather than hand-edit: the timings come from the transcript and
 * hand-tuning them puts the words out of step with the voice. The look is
 * yours, though. Restyle it, move it, change how a phrase arrives; the cue
 * boundaries are the only part that is fixed.
 */
window.LS_CUES = ${data};

(function () {
  const host = document.getElementById("captions");
  if (!host || !window.LS_CUES) return;

  const tl = gsap.timeline();

  for (const cue of window.LS_CUES) {
    const el = document.createElement("div");
    el.className = "cue";
    // Split once, at build time. Splitting on each seek would rebuild the DOM
    // under the renderer and the frame would differ from itself.
    el.innerHTML = cue.t.split(/\\s+/).map((w) => \`<span class="w">\${w}</span>\`).join(" ");
    host.appendChild(el);

    const words = el.querySelectorAll(".w");
    const hold = Math.max(0.35, cue.e - cue.s);

    tl.set(el, { opacity: 1 }, cue.s)
      .fromTo(words,
        { yPercent: 55, opacity: 0 },
        { yPercent: 0, opacity: 1, duration: 0.34, ease: "power3.out",
          stagger: Math.min(0.05, hold / Math.max(words.length, 1) / 2) },
        cue.s)
      .to(el, { opacity: 0, duration: 0.22, ease: "power2.in" }, cue.e);
  }

  // Registered separately so the caption track survives whatever the scenes do.
  window.__timelines = (window.__timelines || []).concat(tl);
})();
`;
}
