/**
 * team-card-clearance.test.ts — pin the team-panel/bubble geometry contract.
 *
 * The floating TeammateCard is position:absolute over the chat log. Assistant
 * (left-aligned) bubbles must reserve enough right padding to never slide
 * under it; user (right-aligned) bubbles stay flush to the right edge. The
 * layout is driven by two CSS custom properties published on .middle-section
 * (App.vue) and consumed in MessageItem.vue and TeammateCard.vue:
 *
 *   --team-card-clearance : the card's footprint from the right edge
 *                           (right offset 16px + card width). 0 when hidden.
 *   --team-card-gap       : breathing room between bubble-right and card-left.
 *
 * These are SOURCE-LEVEL assertions (read the SFCs as text), not computed-style
 * checks: jsdom cannot evaluate media queries or the inherited custom-property
 * cascade, so a DOM test would be vacuous. What we pin is that the contract
 * exists and is internally consistent — the exact bug class where the gap
 * literal drifted from the gap variable, or a refactor dropped the clearance.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const web = (p: string) => readFileSync(resolve(__dirname, '../../web/src', p), 'utf8');

const app = web('App.vue');
const messageItem = web('components/MessageItem.vue');
const teammateCard = web('components/TeammateCard.vue');

describe('team-card clearance contract', () => {
  it('App.vue gates clearance on .has-team-card and defaults it to 0', () => {
    // Base block: hidden by default so the rule is a no-op without a card.
    expect(app).toMatch(/--team-card-clearance:\s*0px/);
    // Visible state publishes a non-zero footprint.
    expect(app).toMatch(/\.middle-section\.has-team-card\s*\{[^}]*--team-card-clearance:\s*(?!0px)\d+px/);
  });

  it('App.vue declares the gap variable', () => {
    expect(app).toMatch(/--team-card-gap:\s*\d+px/);
  });

  it('MessageItem consumes the gap VARIABLE, not a hard-coded literal', () => {
    // The regression this pins: padding-right was `calc(16px + clearance)`,
    // hard-coding 16 while --team-card-gap also existed — two owners, drifting.
    expect(messageItem).toMatch(
      /\.message-row:not\(\.is-user\)\s*\{[^}]*padding-right:\s*calc\(var\(--team-card-gap/,
    );
    // No hard-coded `calc(<number>px + var(--team-card-clearance` remains.
    expect(messageItem).not.toMatch(/padding-right:\s*calc\(\d+px\s*\+\s*var\(--team-card-clearance/);
  });

  it('MessageItem excludes user rows from the clearance', () => {
    // The clearance padding lives on :not(.is-user); user rows keep justify.
    expect(messageItem).toMatch(/\.message-row\.is-user\s*\{[^}]*justify-content:\s*flex-end/);
    expect(messageItem).toMatch(/\.message-row:not\(\.is-user\)\s*\{[^}]*padding-right/);
  });

  it('TeammateCard caps its width by the SAME clearance variable', () => {
    // Single source of truth: the card's max-width derives from clearance.
    expect(teammateCard).toMatch(/max-width:\s*calc\(var\(--team-card-clearance/);
  });

  it('the ≤600px breakpoint is kept in sync on both sides', () => {
    expect(app).toMatch(/@media\s*\(max-width:\s*600px\)/);
    expect(teammateCard).toMatch(/NARROW_QUERY\s*=\s*'\(max-width:\s*600px\)'/);
    // Cross-reference comments tie the two together.
    expect(app).toMatch(/NARROW_QUERY/);
    expect(teammateCard).toMatch(/@media\s*\(max-width:\s*600px\)/);
  });
});
