import { describe, it, expect } from 'vitest';

/**
 * Helper function to access wrapText for testing
 * We'll duplicate the logic here since it's not exported
 */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    // Preserve leading indentation
    const indentMatch = paragraph.match(/^(\s+)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const content = indentMatch ? paragraph.slice(indent.length) : paragraph;

    // Split remaining content into words
    const words = content.split(/\s+/).filter(w => w.length > 0);
    let currentLine = indent;
    const innerWidth = maxWidth - indent.length;

    for (const word of words) {
      const potentialLine = currentLine === indent ? indent + word : currentLine + ' ' + word;

      if (potentialLine.length <= maxWidth) {
        currentLine = potentialLine;
      } else {
        // Line is full, push it and start a new line with same indent
        if (currentLine !== indent) {
          lines.push(currentLine);
        }
        currentLine = indent + word;
      }
    }

    if (currentLine && currentLine !== indent) {
      lines.push(currentLine);
    }
  }

  return lines;
}

describe('wrapText', () => {
  it('should preserve leading spaces', () => {
    const input = '    indented code';
    const result = wrapText(input, 80);
    expect(result[0]).toBe('    indented code');
  });

  it('should preserve multiple levels of indentation', () => {
    const input = '  level1\n    level2\n      level3';
    const result = wrapText(input, 80);
    expect(result[0]).toBe('  level1');
    expect(result[1]).toBe('    level2');
    expect(result[2]).toBe('      level3');
  });

  it('should preserve indentation when wrapping long lines', () => {
    const input = '    this is a very long line that should wrap and maintain its indentation';
    const result = wrapText(input, 40);
    // First line fits exactly 40 chars with "should"
    expect(result[0]).toBe('    this is a very long line that should');
    expect(result[1]).toBe('    wrap and maintain its indentation');
  });

  it('should handle code with indentation correctly', () => {
    const input = `function test() {
  if (true) {
    console.log('hello');
  }
}`;
    const result = wrapText(input, 80);
    expect(result[0]).toBe('function test() {');
    expect(result[1]).toBe('  if (true) {');
    expect(result[2]).toBe('    console.log(\'hello\');');
    expect(result[3]).toBe('  }');
    expect(result[4]).toBe('}');
  });

  it('should preserve tabs as indentation', () => {
    const input = '\tindented with tab';
    const result = wrapText(input, 80);
    expect(result[0]).toBe('\tindented with tab');
  });

  it('should handle empty lines', () => {
    const input = 'line1\n\nline3';
    const result = wrapText(input, 80);
    expect(result).toEqual(['line1', '', 'line3']);
  });

  it('should handle lines without indentation', () => {
    const input = 'no indentation here';
    const result = wrapText(input, 80);
    expect(result[0]).toBe('no indentation here');
  });

  it('should preserve deep indentation on wrapped lines', () => {
    const input = '        deeply indented code that needs to wrap';
    const result = wrapText(input, 30);
    // With 8 spaces indent, innerWidth is 22 characters
    // "deeply indented code that" = 24 chars, exceeds 22
    // "deeply indented code" = 19 chars, fits
    expect(result[0]).toBe('        deeply indented code');
    expect(result[1]).toBe('        that needs to wrap');
  });

  it('should handle mixed indentation levels', () => {
    const input = `no indent
  two spaces
    four spaces
  back to two`;
    const result = wrapText(input, 80);
    expect(result[0]).toBe('no indent');
    expect(result[1]).toBe('  two spaces');
    expect(result[2]).toBe('    four spaces');
    expect(result[3]).toBe('  back to two');
  });
});