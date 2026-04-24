```ts
import type { ToolDefinition, AgentContext } from 'mycc';

export default {
  name: 'tool-name',
  description: 'What this tool does. Be specific for LLM understanding.',
  input_schema: {
    type: 'object',
    properties: {
      param1: { 
        type: 'string', 
        description: 'Parameter description' 
      },
      param2: { 
        type: 'number', 
        description: 'Parameter description',
        enum: ['option1', 'option2']  // Optional: for enum types
      },
    },
    required: ['param1'],  // List required parameters
  },
  scope: ['main', 'child'],  // Adjust scope based on sensitivity

  handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
    const param1 = args.param1 as string;
    const param2 = args.param2 as number | undefined;

    // Validate required parameters
    if (!param1) {
      return 'Error: param1 is required';
    }

    // Log start of operation
    ctx.core.brief('info', 'tool-name', `Processing ${param1}`);

    try {
      // Implementation logic here
      const result = doSomething(param1, param2);

      // Return result
      return `Success: ${result}`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'tool-name', err.message);
      return `Error: ${err.message}`;
    }
  },
} as ToolDefinition;

// Helper function (if needed)
function doSomething(param1: string, param2?: number): string {
  // Implementation
  return 'result';
}
```