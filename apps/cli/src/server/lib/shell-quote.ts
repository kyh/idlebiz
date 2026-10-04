/** `value` as one sh word, single-quoted: a quote inside ends the quoting, is escaped, and starts it again. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;
