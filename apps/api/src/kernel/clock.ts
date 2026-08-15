/**
 * Time as a port.
 *
 * `new Date()` inside a service is an undeclared dependency on the machine's
 * clock, and it is why "published at" assertions turn flaky. The domain asks
 * for the time; something else decides what the time is.
 */
export interface Clock {
  now(): Date;
}
