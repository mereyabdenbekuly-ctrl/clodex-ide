import type {
  McpElicitationField,
  McpElicitationRequest,
} from '@clodex/mcp-runtime';
import type {
  AskUserQuestionsToolInput,
  QuestionField,
} from '@shared/karton-contracts/ui/agent/tools/types';

export function toMcpElicitationQuestion(
  serverDisplayName: string,
  request: McpElicitationRequest,
): AskUserQuestionsToolInput {
  return {
    title: `MCP request — ${serverDisplayName}`,
    description: [
      `**${escapeMarkdown(serverDisplayName)} is requesting information.**`,
      escapeMarkdown(request.message),
      'Submitted values will be sent to this MCP server. Close the form to decline.',
    ].join('\n\n'),
    steps: [
      {
        fields: request.fields.map(toMcpQuestionField),
      },
    ],
  };
}

function toMcpQuestionField(field: McpElicitationField): QuestionField {
  switch (field.kind) {
    case 'text':
      return {
        type: 'input',
        questionId: field.id,
        label: field.label,
        description: field.description,
        inputType: field.inputType === 'email' ? 'email' : 'text',
        validationFormat:
          field.inputType === 'date' ||
          field.inputType === 'date-time' ||
          field.inputType === 'uri'
            ? field.inputType
            : undefined,
        defaultValue: field.defaultValue,
        minLength: field.minLength,
        maxLength: field.maxLength,
        required: field.required,
      };
    case 'number':
      return {
        type: 'input',
        questionId: field.id,
        label: field.label,
        description: field.description,
        inputType: 'number',
        integer: field.integer,
        defaultValue: field.defaultValue,
        min: field.minimum,
        max: field.maximum,
        required: field.required,
      };
    case 'boolean':
      return {
        type: 'checkbox',
        questionId: field.id,
        label: field.label,
        description: field.description,
        defaultValue: field.defaultValue,
      };
    case 'select':
      return {
        type: 'radio-group',
        questionId: field.id,
        label: field.label,
        description: field.description,
        options: field.options,
        defaultValue: field.defaultValue,
        required: field.required,
        allowOther: false,
      };
    case 'multi-select':
      return {
        type: 'checkbox-group',
        questionId: field.id,
        label: field.label,
        description: field.description,
        options: field.options,
        defaultValues: field.defaultValues,
        required: field.required || (field.minItems ?? 0) > 0,
        minItems: field.minItems,
        maxItems: field.maxItems,
      };
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!>|]/g, '\\$&');
}
