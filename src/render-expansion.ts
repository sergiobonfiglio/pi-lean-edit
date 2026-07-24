import type { Component } from "@earendil-works/pi-tui";

export type ExpansionLevel = "minimal" | "medium" | "full";

// ponytail: fixed for now; make configurable only if users need a different cap.
const MEDIUM_MAX_LINES = 20;

class CappedComponent implements Component {
  readonly child: Component;

  constructor(child: Component) {
    this.child = child;
  }

  render(width: number): string[] {
    const lines = this.child.render(width);
    return lines.length <= MEDIUM_MAX_LINES
      ? lines
      : [...lines.slice(0, MEDIUM_MAX_LINES - 1), `… ${lines.length - MEDIUM_MAX_LINES + 1} more lines`];
  }

  handleInput?(data: string): void {
    this.child.handleInput?.(data);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export function asExpansionLevel(value: unknown, fallback: ExpansionLevel): ExpansionLevel {
  return value === "minimal" || value === "medium" || value === "full" ? value : fallback;
}

export function renderWithExpansion<TContext extends { expanded: boolean; lastComponent: Component | undefined; invalidate: () => void }>(
  level: ExpansionLevel,
  context: TContext,
  render: (context: TContext) => Component
): Component {
  const adjusted = {
    ...context,
    // ToolExecutionComponent rebuilds synchronously; invalidating from a renderer must wait for that rebuild to finish.
    invalidate: () => queueMicrotask(() => context.invalidate()),
    expanded: level !== "minimal",
    lastComponent: context.lastComponent instanceof CappedComponent ? context.lastComponent.child : context.lastComponent
  } as TContext;
  const component = render(adjusted);
  return level === "medium" ? new CappedComponent(component) : component;
}
