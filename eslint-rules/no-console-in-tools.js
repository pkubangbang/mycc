/**
 * ESLint rule: no-console-in-tools
 * 
 * Disallows console.* calls in src/tools directory.
 * Tools should use ctx.core.brief() instead for proper logging
 * that respects the agent's output stream.
 */

import path from 'path';

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow console.* calls in src/tools - use ctx.core.brief instead',
      category: 'Best Practices',
      recommended: 'error',
    },
    messages: {
      noConsole: 'Use ctx.core.brief() instead of console.{{method}}() in tools. Example: ctx.core.brief("info", "tool-name", "message")',
    },
    schema: [], // No options
  },

  create(context) {
    // Get the absolute path of the file being linted
    const filePath = context.filename || context.getFilename();
    
    // Normalize path separators to forward slashes
    const normalizedPath = filePath.split(path.sep).join('/');
    
    // Check if this file is in src/tools directory
    const isInToolsDirectory = normalizedPath.includes('/src/tools/');
    
    // Early return if not in src/tools directory
    if (!isInToolsDirectory) {
      return {};
    }
    
    return {
      CallExpression(node) {
        // Check if this is a console.* call
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'console' &&
          node.callee.property.type === 'Identifier'
        ) {
          const methodName = node.callee.property.name;
          
          // List of console methods to disallow
          const disallowedMethods = ['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert'];
          
          if (disallowedMethods.includes(methodName)) {
            context.report({
              node,
              messageId: 'noConsole',
              data: {
                method: methodName,
              },
            });
          }
        }
      },
    };
  },
};