import { useAsync } from "@/renderer/hooks/use-async";
import { useStore, setTalkingTo, teamMessages } from "@/renderer/state/store";
import { Bust } from "@/renderer/ui/bust";
import { employeeName, jobTitle } from "@/renderer/ui/employee-name";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { Modal } from "@/renderer/ui/modal";
import type { Employee } from "@/shared/domain";

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
    className="px-inset flex items-center gap-3 p-2 text-left hover:bg-[#fbf9f2]"
  >
    <Bust seed={emp.spriteSeed} size="md" alt="" />
    <EmployeeTag name={emp.name} title={jobTitle(emp)} lead={lead} status={emp.status} />
  </button>
);

export const Teams = ({ onClose }: { onClose: () => void }) => {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const room = useAsync(() => teamMessages(30), []) ?? [];

  if (!company) {
    return null;
  }
  const headcount = `${employees.length} ${employees.length === 1 ? "person" : "people"}`;

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
        <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {room.length === 0 ? (
            <div className="text-xs text-fg-dim">Quiet so far.</div>
          ) : (
            room.map((m) => (
              <div key={m.id} className="text-xs leading-snug">
                <span className="text-[#3a76b8]">
                  {employeeName(employees, m.fromEmployeeId, "founder")}
                </span>
                <span className="text-fg">: {m.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};
