import { Component, type ReactNode } from "react";
import { errorMessage } from "@/shared/errors";

/**
 * Where a render error in the overlay lands. Without it React unmounts the
 * whole tree, canvas included, and the window goes black with no way back;
 * here the office keeps running underneath and the founder gets a reload.
 */
interface Crashed {
  error: string | null;
}

export class CrashScreen extends Component<{ children: ReactNode }, Crashed> {
  override state: Crashed = { error: null };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- React hands over whatever was thrown
  static getDerivedStateFromError(cause: unknown): Crashed {
    return { error: errorMessage(cause) };
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#10121b]/90 p-6">
        <div className="px-battle w-full max-w-lg p-4">
          <div className="text-base text-fg">Something in the office broke</div>
          <div className="mt-1 text-sm leading-relaxed text-fg-dim">
            The panel crashed while drawing. Your company is safe on disk; reload the window to pick
            up where it was.
          </div>
          <div className="px-inset mt-2 p-2 text-xs text-fg-dim">{this.state.error}</div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-btn-accent px-btn"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
