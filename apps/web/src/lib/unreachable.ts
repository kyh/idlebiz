/** Ends a switch that names every case: one added to the union later fails to compile there. */
export const unreachable = (value: never): never => {
  throw new Error(`no case for ${JSON.stringify(value)}`);
};
