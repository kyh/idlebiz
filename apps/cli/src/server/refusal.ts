/**
 * A command turned down, worded as the sentence its caller should read as the
 * answer: a tool hands it to the agent, IPC to the founder. Anything else
 * thrown is a fault, and whoever catches it reports it.
 */
export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusalError";
  }
}
