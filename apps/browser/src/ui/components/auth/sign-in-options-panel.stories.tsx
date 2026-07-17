import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { SignInOptionsPanel } from './sign-in-options-panel';

const meta = {
  title: 'Auth/SignInOptionsPanel',
  component: SignInOptionsPanel,
  parameters: {
    layout: 'fullscreen',
    visualRegression: true,
  },
  args: {
    sendOtp: async () => ({}),
    verifyOtp: async () => ({}),
    signInSocial: async () => ({}),
    signInEmail: async () => ({}),
    signInTelegram: async () => ({}),
    onUseApiKeys: () => undefined,
    onUseSubscription: () => undefined,
    trackingPrefix: 'onboarding-auth',
    track: () => undefined,
    openExternalUrl: () => undefined,
  },
} satisfies Meta<typeof SignInOptionsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Centered: Story = {
  render: (args) => (
    <div className="h-screen min-h-[640px] w-screen">
      <SignInOptionsPanel {...args} />
    </div>
  ),
};

export const CompactSection: Story = {
  args: {
    variant: 'section',
    title: 'Вход в CLODEx',
    description: 'Авторизация откроется на CLODEx.xyz в системном браузере.',
    trackingPrefix: 'account-auth',
  },
  render: (args) => (
    <div className="flex min-h-screen items-center justify-center bg-[#080a08] p-6">
      <div className="w-full max-w-2xl">
        <SignInOptionsPanel {...args} />
      </div>
    </div>
  ),
};

export const BackendError: Story = {
  args: {
    signInEmail: async () => ({
      error: 'Не удалось подтвердить callback от CLODEx.xyz.',
    }),
  },
  render: (args) => (
    <div className="h-screen min-h-[640px] w-screen">
      <SignInOptionsPanel {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Войти через CLODEx.xyz' }),
    );
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      'Не удалось подтвердить callback от CLODEx.xyz.',
    );
  },
};
