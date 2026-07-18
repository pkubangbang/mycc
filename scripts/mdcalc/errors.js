/**
 * errors.js — the three error layers (L1 format / L2 action / L3 calc).
 *
 * Each error carries its layer so the pipeline can decide whether to abort
 * (L1) or collect-and-continue (L2/L3). The formatted `message` is what ends
 * up in stderr and, for L2/L3, in the file's `# 错误` section.
 */

export class L1Error extends Error {
  constructor(m) {
    super(`[L1:format] ${m}`);
    this.layer = 1;
  }
}

export class L2Error extends Error {
  constructor(idx, op, area, m) {
    super(`[L2:action] op #${idx} (op=${op || '?'}, area=${area || '?'}) ${m}`);
    this.layer = 2;
    this.opIndex = idx;
  }
}

export class L3Error extends Error {
  constructor(cell, expr, m) {
    super(`[L3:calc] cell ${cell} formula "${expr}" ${m}`);
    this.layer = 3;
    this.cell = cell;
  }
}