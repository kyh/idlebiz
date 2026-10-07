/** What a call that answers nothing answers: it worked, or it threw. */
// oxlint-disable-next-line typescript/no-invalid-void-type -- a procedure's output is its handler's return type, and a handler that answers nothing returns void
export type Done = void;
