import { z } from 'zod';
import { credentialField, type CredentialTypeDefinition } from './types';

const schema = z.object({
  accessToken: credentialField(),
});

type ClodexAuthShape = typeof schema.shape;

export const clodexAuthCredentialType: CredentialTypeDefinition<ClodexAuthShape> =
  {
    displayName: 'Clodex Access Token',
    description:
      'Automatically provided when you are signed in to Clodex. Grants access to the Clodex API.',
    schema,
    allowedOrigins: ['https://clodex.xyz', 'https://*.clodex.xyz'],
    fieldMetadata: {},
    onGet: async (current) => current,
  };
