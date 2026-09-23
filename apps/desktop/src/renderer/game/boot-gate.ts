type Op<T> = (target: T) => void;

type GateState<T> =
  | { readonly kind: "booting"; readonly held: Op<T>[] }
  | { readonly kind: "open"; readonly target: T }
  | { readonly kind: "shut" };

/**
 * Work for something that is still booting: held while it boots, run in order
 * once it opens, then run as it comes. Shut, it drops everything until the next
 * boot, so a boot that outlived its teardown cannot open it again.
 */
export class BootGate<T> {
  private state: GateState<T> = { kind: "shut" };

  /** Start holding; whatever an earlier boot held is dropped. */
  boot(): void {
    this.state = { held: [], kind: "booting" };
  }

  /** Run what the boot held, in order, and everything after as it comes. */
  open(target: T): void {
    if (this.state.kind !== "booting") {
      return;
    }
    const { held } = this.state;
    this.state = { kind: "open", target };
    for (const op of held) {
      op(target);
    }
  }

  shut(): void {
    this.state = { kind: "shut" };
  }

  run(op: Op<T>): void {
    if (this.state.kind === "booting") {
      this.state.held.push(op);
    } else if (this.state.kind === "open") {
      op(this.state.target);
    }
  }
}
