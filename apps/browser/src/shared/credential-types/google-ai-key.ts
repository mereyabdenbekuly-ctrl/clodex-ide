import { z } from 'zod';
import { credentialField, type CredentialTypeDefinition } from './types';

const schema = z.object({
  apiKey: credentialField(),
});

type GoogleAiKeyShape = typeof schema.shape;

export const googleAiKeyCredentialType: CredentialTypeDefinition<GoogleAiKeyShape> =
  {
    displayName: 'Google AI API Key',
    description:
      'API key for the Google AI (Gemini) REST API. Enables image generation, text generation, and other Gemini model capabilities.',
    schema,
    allowedOrigins: ['https://generativelanguage.googleapis.com'],
    fieldMetadata: {
      apiKey: {
        description: 'API Key',
        helpText: 'Create one at Google AI Studio → Get API key',
        helpUrl: 'https://aistudio.google.com/app/apikey',
      },
    },
    onGet: async (current) => current,
  };
