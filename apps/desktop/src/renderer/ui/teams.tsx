import { useEffect, useRef } from "react";
import { useAsync } from "@/renderer/hooks/use-async";
import { newestRoomLine } from "@/renderer/state/activity-reducer";
import { useStore, setTalkingTo, teamMessages } from "@/renderer/state/store";
import { Bust } from "@/renderer/ui/bust";
import { employeeName, jobTitle } from "@/renderer/ui/employee-name";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { Modal } from "@/renderer/ui/modal";
import type { Employee, TeamMessage } from "@repo/domain/domain";

const RosterCard = ({
  emp,
  lead,
  onTalk,
}: {
  emp: Employee;
  lead: boolean;
  onTalk: () => void;
}) => (
  <button
    type="button"
    onClick={onTalk}
    title={`Talk to ${emp.name}`}
    className="px-inset px-inset-hover flex items-center gap-3 p-2 text-left"
  >
    <Bust seed={emp.spriteSeed} size="md" alt="" />
    <EmployeeTag name={emp.name} title={jobTitle(emp)} lead={lead} status={emp.status} />
  </button>
);

const RoomLine = ({
  message,
  employees,
}: {
  message: TeamMessage;
  employees: readonly Employee[];
}) => {
  const { from, text } = message;
  if (from.kind === "office") {
    return <div className="text-xs leading-snug text-fg-dim">{text}</div>;
  }
  return (
    <div className="text-xs leading-snug">
      <span className="text-[#3a76b8]">
        {from.kind === "founder" ? "you" : employeeName(employees, from.id, "former teammate")}
      </span>
      <span className="text-fg">: {text}</span>
    </div>
  );
};

export const Teams = ({ onClose }: { onClose: () => void }) => {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  // the feed hears each line as it is said; the room is read again for it in full
  const said = useStore((s) => newestRoomLine(s.feed));
  const room = useAsync(() => teamMessages(30), [said]);
  const messages = room.kind === "ready" ? room.value : [];
  const newest = messages.at(-1)?.id;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && newest !== undefined) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [newest]);

  if (!company) {
    return null;
  }
  const headcount = `${employees.length} ${employees.length === 1 ? "person" : "people"}`;
  const quiet = room.kind === "failed" ? room.message : "Quiet so far.";

  return (
    <Modal title="Team" subtitle={headcount} width="2xl" onClose={onClose}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {employees.map((e) => (
          <RosterCard
            key={e.id}
            emp={e}
            lead={e.id === company.leaderId}
            onTalk={() => {
              onClose();
              setTalkingTo(e.id);
            }}
          />
        ))}
      </div>
      <div className="px-inset mt-3 p-3">
        <div className="text-xs uppercase tracking-wide text-fg-dim">Team room</div>
        <div ref={scrollRef} className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="text-xs text-fg-dim">{quiet}</div>
          ) : (
            messages.map((m) => <RoomLine key={m.id} message={m} employees={employees} />)
          )}
        </div>
      </div>
    </Modal>
  );
};
