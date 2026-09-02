import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripInternalMarkup } from '../../src/utils/letter-box.js';

// Capture stdout for displayLetterBox tests
let stdoutData: string[] = [];
const originalStdoutWrite = process.stdout.write;

function captureStdout() {
  stdoutData = [];
  process.stdout.write = ((chunk: any): boolean => {
    stdoutData.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

function restoreStdout() {
  process.stdout.write = originalStdoutWrite;
}

// Fullwidth vertical line character used in DeepSeek DSML tags (U+FF5C)
const FW_VLINE = '\uff5c';
const FW_DSML_OPEN = '<' + FW_VLINE + FW_VLINE + 'DSML' + FW_VLINE + FW_VLINE;
const FW_DSML_CLOSE = '</' + FW_VLINE + FW_VLINE + 'DSML' + FW_VLINE + FW_VLINE;

/**
 * Helper: build a DSML opening tag, e.g. <||DSML||tool_calls>
 */
function dsmlOpen(name: string): string {
  return FW_DSML_OPEN + name + '>';
}

/**
 * Helper: build a DSML closing tag, e.g. </||DSML||tool_calls>
 */
function dsmlClose(name: string): string {
  return FW_DSML_CLOSE + name + '>';
}

describe('stripInternalMarkup', () => {
  it('should strip full DSML paired tags with content', () => {
    const input = [
      'Some text before.',
      dsmlOpen('tool_calls'),
      dsmlOpen('invoke'),
      dsmlOpen('parameter') + 'Hello' + dsmlClose('parameter'),
      dsmlClose('invoke'),
      dsmlClose('tool_calls'),
      'Some text after.',
    ].join('\n');

    const result = stripInternalMarkup(input);
    expect(result).toBe('Some text before.\n\nSome text after.');
  });

  it('should strip multiple DSML tags', () => {
    const input = dsmlOpen('tag1') + 'content1' + dsmlClose('tag1') + ' keep ' +
                  dsmlOpen('tag2') + 'content2' + dsmlClose('tag2');
    const result = stripInternalMarkup(input);
    expect(result).toBe('keep');
  });

  it('should strip self-closing DSML tags', () => {
    const input = 'hello ' + FW_DSML_OPEN + 'br /> world';
    const result = stripInternalMarkup(input);
    expect(result).toBe('hello  world');
  });

  it('should strip orphaned opening DSML tags', () => {
    const input = 'some text ' + dsmlOpen('foo') + ' more text';
    const result = stripInternalMarkup(input);
    expect(result).toBe('some text  more text');
  });

  it('should strip orphaned closing DSML tags', () => {
    const input = 'text' + dsmlClose('bar') + 'done';
    const result = stripInternalMarkup(input);
    expect(result).toBe('textdone');
  });

  it("should handle the exact example from changelog-todo.md (verbatim)", () => {
    // This matches the raw text from the file:
    // fullwidth vertical bars (U+FF5C) wrapping "DSML" prefix + tag name
    const input = [
      dsmlOpen('tool_calls'),
      dsmlOpen('invoke name="brief"'),
      dsmlOpen('parameter name="message" string="true"') +
        '\u{1F680} Merged into local `main` (commit 9aa4be5). ' +
        'The remote `origin/main` appears to be behind (at 62a9469). ' +
        'The push said "Everything up-to-date" \u2014 might need a force push ' +
        "or there's a discrepancy. Want me to investigate and push properly, " +
        'or is this fine as-is?' +
        dsmlClose('parameter'),
      dsmlClose('invoke'),
      dsmlClose('tool_calls'),
    ].join('\n');

    const result = stripInternalMarkup(input);
    expect(result).toBe('');
  });

  it("should handle the verbatim raw bytes from changelog-todo.md", () => {
    // Copy-pasted from the actual file bytes:
    // <\xef\xbd\x9c\xef\xbd\x9cDSML\xef\xbd\x9c\xef\xbd\x9ctool_calls>
    // Using the exact characters read from the file
    const fv = '\uff5c';
    const rawExample =
      '   <' + fv + fv + 'DSML' + fv + fv + 'tool_calls>\r\n' +
      '   <' + fv + fv + 'DSML' + fv + fv + 'invoke name="brief">\r\n' +
      '   <' + fv + fv + 'DSML' + fv + fv + 'parameter name="message" string="true">' +
        '\u{1F680} Merged into local `main` (commit 9aa4be5). ' +
        'The remote `origin/main` appears to be behind (at 62a9469). ' +
        'The push said "Everything up-to-date" \u2014 might need a force push ' +
        "or there's a discrepancy. Want me to investigate and push properly, " +
        'or is this fine as-is?' +
        '</' + fv + fv + 'DSML' + fv + fv + 'parameter>\r\n' +
      '   </' + fv + fv + 'DSML' + fv + fv + 'invoke>\r\n' +
      '   </' + fv + fv + 'DSML' + fv + fv + 'tool_calls>';

    const result = stripInternalMarkup(rawExample);
    expect(result).toBe('');
  });

  it('should preserve normal text without any tags', () => {
    const input = 'Hello, this is a normal message with no markup.';
    const result = stripInternalMarkup(input);
    expect(result).toBe(input);
  });

  it('should handle content that has no fullwidth vertical lines efficiently', () => {
    const input = 'Regular text with <b>html</b> that should stay as-is.';
    const result = stripInternalMarkup(input);
    expect(result).toBe(input);
  });
});

// We need to import displayLetterBox for the display tests.
// Since it's a side-effect function (writes to stdout), we test via stdout capture.
import { displayLetterBox } from '../../src/utils/letter-box.js';

describe('displayLetterBox', () => {
  beforeEach(() => {
    captureStdout();
  });

  afterEach(() => {
    restoreStdout();
  });

  it('should show fallback content when all text is DSML markup', () => {
    const input = dsmlOpen('tool_calls') + dsmlOpen('invoke') +
      dsmlOpen('parameter') + 'hello' + dsmlClose('parameter') +
      dsmlClose('invoke') + dsmlClose('tool_calls');

    displayLetterBox(input);

    const output = stdoutData.join('');
    // Should contain the fallback message, not empty content
    expect(output).toContain('no displayable content');
    // Should still have box borders
    expect(output).toContain('.=');
  });

  it('should show normal content when text survives stripping', () => {
    const input = 'Hello, this is real content.';

    displayLetterBox(input);

    const output = stdoutData.join('');
    expect(output).toContain('Hello, this is real content.');
  });
});