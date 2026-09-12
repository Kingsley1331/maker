import type { Schedule, Scheduled } from "./shapes";

/**
 * Simulated seconds elapsed per settings object. Keying on the object itself means the clock
 * restarts whenever a setting is replaced (every UI change, scene load, duplicate) with no
 * explicit reset, and it is garbage-collected with the setting.
 */
const elapsedBy = new WeakMap<Scheduled, number>();

/**
 * Tolerance (seconds) on phase boundaries. Elapsed time is a sum of 1/60 s steps, so 60 of them
 * land a hair either side of 1 s; without this a boundary could gain or lose one step.
 */
const EDGE_EPS = 1e-6;

function phaseOn(schedule: Schedule, elapsed: number): boolean {
  const phases = schedule.phases;
  let total = 0;
  for (const phase of phases) total += Math.max(0, phase.seconds);
  if (total <= 0) return false;

  let t = elapsed;
  if (schedule.loop) {
    t = elapsed % total;
    // A value within EDGE_EPS below the cycle length is really the start of the next cycle.
    if (t >= total - EDGE_EPS) t -= total;
  }

  // Walk the rows in order; `t` belongs to the first phase whose end it has not yet reached.
  let start = 0;
  for (const phase of phases) {
    const end = start + Math.max(0, phase.seconds);
    if (t >= start - EDGE_EPS && t < end - EDGE_EPS) return phase.kind === "on";
    start = end;
  }
  // Past the last phase (no loop): stay off.
  return false;
}

/**
 * Whether the effect is on for the step that starts now, then advance its clock by `dt`. Settings
 * without a schedule are always on.
 */
export function advanceSchedule(settings: Scheduled, dt: number): boolean {
  if (!settings.schedule) return true;
  const elapsed = elapsedBy.get(settings) ?? 0;
  elapsedBy.set(settings, elapsed + dt);
  return phaseOn(settings.schedule, elapsed);
}

/** Whether the effect is currently on, without advancing its clock (for drawing). */
export function isScheduleOn(settings: Scheduled): boolean {
  if (!settings.schedule) return true;
  return phaseOn(settings.schedule, elapsedBy.get(settings) ?? 0);
}
