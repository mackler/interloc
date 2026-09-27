// The time of a chat message as the page shows it (issue #1). Pure and total: an ISO string the page cannot read is
// shown as it is, never thrown on (Intl.DateTimeFormat.format throws a RangeError on an invalid date).

const format = (iso: string, options: Intl.DateTimeFormatOptions, locale: string | undefined): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Intl.DateTimeFormat(locale, options).format(ms);
};

/** The clock time to the second, for example 14:03:27, in the locale and time zone given (the browser's by default). */
export const clockTime = (iso: string, locale?: string, timeZone?: string): string =>
  format(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone }, locale);

/** The full date and time, for the message's title. */
export const fullTime = (iso: string, locale?: string, timeZone?: string): string =>
  format(iso, { dateStyle: "full", timeStyle: "medium", timeZone }, locale);
