// Who sits where, as a pure function.
//
// The scene used to pick a seat at spawn time and never revisit it, so the
// twelfth hire in an eleven-desk office simply never appeared. Planning the
// whole roster at once, against the previous plan, gives stable seats (nobody
// is shuffled to make room) and a definite answer for overflow (null: they
// stand). The scene's director turns the plan's diffs into walking.

/** An employee as the planner sees them: identity plus the desk they were hired into. */
export interface SeatedEmployee {
  readonly id: string;
  /** The seat index they were assigned at hire — honoured when free. */
  readonly deskIndex: number;
}

/** employee id → index into the layout's work seats, or null when none is free. */
export type SeatPlan = ReadonlyMap<string, number | null>;

/**
 * Assign every employee a work seat.
 *
 * Incumbents keep the seat they had (first pass), so a hire or a release never
 * moves anyone who was already sitting. Newcomers take the desk they were hired
 * into when it is free, else the lowest free seat, else none. Order of
 * `employees` breaks ties, so the roster's own order is the priority order.
 */
export function planSeats(
  seatCount: number,
  employees: readonly SeatedEmployee[],
  previous: SeatPlan,
): SeatPlan {
  const plan = new Map<string, number | null>();
  const taken = new Set<number>();
  const claim = (id: string, seat: number): void => {
    plan.set(id, seat);
    taken.add(seat);
  };

  for (const emp of employees) {
    const prior = previous.get(emp.id);
    if (prior === undefined || prior === null) continue;
    if (prior < seatCount && !taken.has(prior)) claim(emp.id, prior);
  }

  for (const emp of employees) {
    if (plan.has(emp.id)) continue;
    if (seatCount === 0) {
      plan.set(emp.id, null);
      continue;
    }
    const preferred = ((emp.deskIndex % seatCount) + seatCount) % seatCount;
    if (!taken.has(preferred)) {
      claim(emp.id, preferred);
      continue;
    }
    let free: number | null = null;
    for (let i = 0; i < seatCount; i += 1) {
      if (!taken.has(i)) {
        free = i;
        break;
      }
    }
    if (free === null) plan.set(emp.id, null);
    else claim(emp.id, free);
  }
  return plan;
}
