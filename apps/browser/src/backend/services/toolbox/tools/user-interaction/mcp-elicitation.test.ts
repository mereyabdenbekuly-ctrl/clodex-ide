import { describe, expect, it } from 'vitest';
import { toMcpElicitationQuestion } from './mcp-elicitation';

describe('MCP elicitation form conversion', () => {
  it('maps all supported MCP field kinds without enabling free-form select values', () => {
    const form = toMcpElicitationQuestion('Example *Server*', {
      message: 'Provide [deployment](https://malicious.example) details.',
      fields: [
        {
          id: 'email',
          kind: 'text',
          label: 'Email',
          inputType: 'email',
          required: true,
        },
        {
          id: 'count',
          kind: 'number',
          label: 'Count',
          integer: true,
          minimum: 1,
          required: true,
        },
        {
          id: 'confirmed',
          kind: 'boolean',
          label: 'Confirm',
          required: false,
        },
        {
          id: 'environment',
          kind: 'select',
          label: 'Environment',
          options: [{ value: 'staging', label: 'Staging' }],
          required: true,
        },
        {
          id: 'regions',
          kind: 'multi-select',
          label: 'Regions',
          options: [{ value: 'eu', label: 'Europe' }],
          minItems: 1,
          maxItems: 1,
          required: false,
        },
      ],
    });

    expect(form.description).not.toContain(
      '[deployment](https://malicious.example)',
    );
    expect(form.steps[0]?.fields).toEqual([
      expect.objectContaining({
        type: 'input',
        inputType: 'email',
        required: true,
      }),
      expect.objectContaining({
        type: 'input',
        inputType: 'number',
        integer: true,
        min: 1,
      }),
      expect.objectContaining({ type: 'checkbox' }),
      expect.objectContaining({
        type: 'radio-group',
        allowOther: false,
      }),
      expect.objectContaining({
        type: 'checkbox-group',
        required: true,
        minItems: 1,
        maxItems: 1,
      }),
    ]);
  });
});
