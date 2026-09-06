import { useAsync } from "@/renderer/hooks/use-async";
import { useStore, teamMessages } from "@/renderer/state/store";
import { employeeName } from "@/renderer/ui/employee-name";
import { Modal } from "@/renderer/ui/modal";

/** The Team panel: who is on it, who leads, and the room they talk in. */
export function Teams({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const room = useAsync(() => teamMessages(30), []) ?? [];

  if (!company) return null;
  const headcount = `${employees.length} ${employees.length === 1 ? "person" : "people"}`;

  return (
    <Modal title="Team" subtitle={headcount} width="2xl" onClose={onClose}>
      <div className="px-inset p-3">
        <div className="flex flex-wrap gap-1.5">
          {employees.map((e) => (
            <span
              key={e.id}
              className="px-plate px-2 py-0.5 text-xs"
              title={e.title}
              style={e.id === company.leaderId ? { color: "#e8d28a" } : undefined}
            >
              {e.id === company.leaderId ? "★ " : ""}
              {e.name}
            </span>
          ))}
        </div>
        <div className="mt-3 text-xs uppercase tracking-wide text-fg-dim">Team room</div>
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
}
