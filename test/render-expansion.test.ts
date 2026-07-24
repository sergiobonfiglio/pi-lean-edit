import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { asExpansionLevel, renderWithExpansion } from "../src/render-expansion.ts";

class Lines implements Component {
  render(): string[] {
    return Array.from({ length: 25 }, (_, index) => String(index + 1));
  }

  invalidate(): void {}
}

const context = { expanded: true, lastComponent: undefined as Component | undefined, invalidate: () => {} };

test("expansion levels select collapsed, capped, and full rendering", () => {
  let expanded = true;
  const minimal = renderWithExpansion("minimal", context, (adjusted) => {
    expanded = adjusted.expanded;
    return new Lines();
  });
  assert.equal(expanded, false);
  assert.equal(minimal.render(80).length, 25);

  const child = new Lines();
  const medium = renderWithExpansion("medium", context, (adjusted) => {
    assert.equal(adjusted.expanded, true);
    return child;
  });
  assert.deepEqual(medium.render(80), [...Array.from({ length: 19 }, (_, index) => String(index + 1)), "… 6 more lines"]);
  renderWithExpansion("medium", { ...context, lastComponent: medium }, (adjusted) => {
    assert.equal(adjusted.lastComponent, child);
    return child;
  });

  const full = renderWithExpansion("full", context, () => new Lines());
  assert.equal(full.render(80).length, 25);
});
test("renderer invalidation is deferred until its current rebuild completes", async () => {
  let invalidated = false;
  renderWithExpansion("full", { ...context, invalidate: () => { invalidated = true; } }, (adjusted) => {
    adjusted.invalidate();
    assert.equal(invalidated, false);
    return new Lines();
  });
  await Promise.resolve();
  assert.equal(invalidated, true);
});

test("invalid persisted expansion values use defaults", () => {
  assert.equal(asExpansionLevel("full", "minimal"), "full");
  assert.equal(asExpansionLevel("verbose", "minimal"), "minimal");
});
