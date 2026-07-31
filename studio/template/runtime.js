/**
 * The plumbing every composition needs, so no job has to invent it again.
 *
 * A real run spent thirty minutes writing a namespace, a builder registry, a
 * load-order queue and an assembler in Python, then hit its deadline before
 * rendering anything. None of that was about the video. It is the same code
 * every time and it is here so a turn starts at the interesting part.
 *
 * The renderer seeks: it sets a time and screenshots, over and over, in any
 * order. So nothing here may depend on when it ran, only on what time it is
 * being asked about. No Date.now, no Math.random, no fetch during construction.
 */

window.LS = (function () {
  const scenes = [];
  let master = null;

  /**
   * Register a scene builder.
   *
   * Order-independent on purpose. Script tags load in whatever order the
   * compiler emits them, and a builder that assumed it ran after another one
   * was the specific bug that cost a job its deadline. Each builder declares
   * its own id and gets its own element and window.
   */
  function scene(id, build) {
    scenes.push({ id, build });
  }

  /**
   * Build the master timeline and hand it to the renderer.
   *
   * Called once, after every builder has registered. Each scene's timeline is
   * placed at its own data-start, read off the element, so a scene's internal
   * time always starts at zero and can be reasoned about on its own.
   */
  function start() {
    master = gsap.timeline({ paused: true });

    for (const { id, build } of scenes) {
      const el = document.getElementById(id);
      if (!el) {
        console.warn(`[LS] no element for scene "${id}"`);
        continue;
      }
      const at = Number(el.dataset.start ?? 0);
      const dur = Number(el.dataset.duration ?? 0);

      // Present only for its own window. Without this every scene is on screen
      // for the whole piece and the last one wins, which renders as one frozen
      // frame for thirty seconds.
      master.set(el, { autoAlpha: 1 }, at);
      if (dur > 0) master.set(el, { autoAlpha: 0 }, at + dur);

      let tl = null;
      try {
        tl = build(el, { duration: dur, start: at });
      } catch (err) {
        // One broken scene must not take the whole render with it. It renders
        // empty and the contact sheet shows exactly which second is wrong.
        console.error(`[LS] scene "${id}" failed to build:`, err);
      }
      if (tl) master.add(tl, at);
    }

    // The renderer seeks whatever it finds here.
    window.__timelines = [master];
    return master;
  }

  return { scene, start, get master() { return master; } };
})();

// Everything starts hidden. A scene reveals itself at its own cue, and anything
// that has not been given a cue should not be on screen at frame zero.
document.addEventListener("DOMContentLoaded", () => {
  gsap.set(".scene", { autoAlpha: 0 });
});
