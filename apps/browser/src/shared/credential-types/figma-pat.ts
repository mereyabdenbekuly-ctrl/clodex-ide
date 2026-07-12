import { z } from 'zod';
import { credentialField, type CredentialTypeDefinition } from './types';

const schema = z.object({
  token: credentialField(),
});

type FigmaPatShape = typeof schema.shape;

export const figmaPatCredentialType: CredentialTypeDefinition<FigmaPatShape> = {
  displayName: 'Figma Personal Access Token',
  description:
    'Personal Access Token for the Figma REST API. Allows reading files, components, images, styles, and project metadata.',
  schema,
  allowedOrigins: ['https://api.figma.com'],
  fieldMetadata: {
    token: {
      description: 'Personal Access Token',
      helpText:
        'Create one at figma.com \u2192 Settings \u2192 Security \u2192 Personal access tokens',
      helpUrl:
        'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens',
    },
  },
  onGet: async (current) => current,
};
