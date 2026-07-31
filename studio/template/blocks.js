/**
 * The moves this studio makes, as functions.
 *
 * Watching real runs, the agent spent most of its turn writing the same
 * primitives from first principles: a number that counts, two states compared
 * in one layout, a line that draws itself, a meter that fills, a flow whose
 * boxes light in order. They are always the same code and they are always the
 * hard part to get deterministic.
 *
 * So they live here and the agent composes with them. Every one is seekable:
 * built on a GSAP timeline, driven only by its own time, with no wall clock and
 * no randomness, so the renderer gets the same pixels for the same frame every
 * time it asks.
 *
 * Each returns a timeline for the caller to place on the master.
 */

/* eslint-disable no-undef */

/** Ease vocabulary, named once so a piece stays coherent. */
const E = {
  arrive: "power3.out",
  travel: "power2.inOut",
  settle: "power4.out",
  linear: "none",
};

/**
 * Type that arrives behind a moving mask.
 *
 * clip-path rather than opacity, because a wipe reads as deliberate and a fade
 * reads as a default.
 */
function revealText(el, { duration = 0.7, from = "left", delay = 0 } = {}) {
  const hidden = {
    left: "inset(0 100% 0 0)",
    right: "inset(0 0 0 100%)",
    up: "inset(100% 0 0 0)",
  }[from] ?? "inset(0 100% 0 0)";
  return gsap.timeline().fromTo(el,
    { clipPath: hidden, y: from === "up" ? 14 : 0 },
    { clipPath: "inset(0 0% 0 0)", y: 0, duration, ease: E.arrive, delay });
}

/**
 * Words arriving one after another.
 *
 * Splits on spaces once, at build time, so seeking never re-splits and the DOM
 * is stable across frames.
 */
function staggerWords(el, { duration = 0.5, each = 0.045, delay = 0 } = {}) {
  if (!el.dataset.split) {
    el.innerHTML = el.textContent.trim().split(/\s+/)
      .map((w) => `<span class="w">${w}</span>`).join(" ");
    el.dataset.split = "1";
  }
  return gsap.timeline().fromTo(el.querySelectorAll(".w"),
    { yPercent: 40, opacity: 0 },
    { yPercent: 0, opacity: 1, duration, ease: E.arrive, stagger: each, delay });
}

/**
 * A number that counts to its value.
 *
 * The element keeps its final value in data-to so a seek to any time renders
 * the right figure rather than whatever the last tween left behind. Never
 * overshoots: a figure that flies past its value and falls back has rendered a
 * number that was never true.
 */
function countTo(el, to, { duration = 1.2, prefix = "", suffix = "", decimals = 0, delay = 0 } = {}) {
  const state = { v: Number(el.dataset.from ?? 0) };
  const fmt = (n) => prefix + n.toLocaleString("en-US", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }) + suffix;
  return gsap.timeline().to(state, {
    v: to, duration, ease: E.settle, delay,
    onUpdate: () => { el.textContent = fmt(state.v); },
  });
}

/**
 * The same situation twice, so the only thing that moves is the difference.
 *
 * The before state stays on screen while the after arrives. Showing them in
 * sequence, with the first gone, asks the viewer to remember rather than
 * compare, which is the entire point of the shot.
 */
function beforeAfter(beforeEl, afterEl, { duration = 0.8, hold = 0.6, strike = null } = {}) {
  const tl = gsap.timeline();
  tl.fromTo(beforeEl, { opacity: 0, x: -18 },
    { opacity: 1, x: 0, duration, ease: E.arrive });
  if (strike) {
    tl.fromTo(strike, { scaleX: 0 },
      { scaleX: 1, duration: 0.4, ease: E.travel, transformOrigin: "left center" }, `+=${hold}`);
  }
  tl.fromTo(afterEl, { opacity: 0, x: 18 },
    { opacity: 1, x: 0, duration, ease: E.arrive }, strike ? "-=0.1" : `+=${hold}`);
  return tl;
}

/**
 * A line that draws itself, for SVG connectors in a diagram.
 *
 * Measured at build time so the dash offset is correct whatever the path.
 */
function drawLine(pathEl, { duration = 0.8, delay = 0 } = {}) {
  const len = pathEl.getTotalLength();
  gsap.set(pathEl, { strokeDasharray: len, strokeDashoffset: len });
  return gsap.timeline().to(pathEl, { strokeDashoffset: 0, duration, ease: E.travel, delay });
}

/** A bar or meter filling on one axis. */
function fillMeter(fillEl, to = 1, { duration = 0.9, delay = 0 } = {}) {
  return gsap.timeline().fromTo(fillEl,
    { scaleX: 0 }, { scaleX: to, duration, ease: E.settle, delay });
}

/**
 * A flow whose parts arrive in the order they happen.
 *
 * Nodes light one at a time and the connector between them draws before the
 * node it points at reacts, because that is the order the thing actually
 * occurs in. Everything appearing at once is a picture of a system, not an
 * explanation of one.
 */
function flow(nodes, paths, { nodeDur = 0.45, pathDur = 0.5, gap = 0.12 } = {}) {
  const tl = gsap.timeline();
  nodes.forEach((node, i) => {
    tl.fromTo(node, { opacity: 0, scale: 0.94 },
      { opacity: 1, scale: 1, duration: nodeDur, ease: E.arrive }, i === 0 ? 0 : `+=${gap}`);
    const path = paths[i];
    if (path) tl.add(drawLine(path, { duration: pathDur }), `-=${nodeDur * 0.3}`);
  });
  return tl;
}

/**
 * Something advancing until a limit stops it.
 *
 * The literal picture of an enforced ceiling: a bar travels, meets the mark,
 * and does not pass it. Written because "show a padlock" is the reflex and it
 * explains nothing.
 */
function stopAtLimit(moverEl, limitEl, { duration = 1.1, overshoot = 0 } = {}) {
  const limitX = limitEl.offsetLeft;
  const startX = moverEl.offsetLeft;
  return gsap.timeline()
    .fromTo(moverEl, { x: 0 },
      { x: limitX - startX + overshoot, duration, ease: E.travel })
    .to(limitEl, { scaleY: 1.35, duration: 0.12, yoyo: true, repeat: 1, ease: E.travel }, "-=0.05")
    .fromTo(limitEl, { backgroundColor: "var(--dim)" },
      { backgroundColor: "var(--accent)", duration: 0.2 }, "<");
}

/**
 * The ambient idle every held element carries.
 *
 * A frame where nothing at all moves is the single biggest cheap-motion tell,
 * and a scene that has said its piece still has to breathe until the cut.
 */
function idle(el, { scale = 1.02, duration = 6 } = {}) {
  return gsap.timeline({ repeat: -1, yoyo: true })
    .fromTo(el, { scale: 1 }, { scale, duration, ease: "sine.inOut" });
}

/** A slow continuous camera move across a plate, for scenes built on an image. */
function drift(el, { x = 0, y = 0, scale = 1.08, duration = 6 } = {}) {
  return gsap.timeline().fromTo(el,
    { scale: 1, xPercent: 0, yPercent: 0 },
    { scale, xPercent: x, yPercent: y, duration, ease: E.linear });
}
