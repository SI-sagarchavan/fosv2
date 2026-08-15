import type { Clock } from "../kernel/clock.js";

/** The real clock. The only place in the application allowed to call `new Date()`. */
export const systemClock: Clock = {
  now: () => new Date(),
};
