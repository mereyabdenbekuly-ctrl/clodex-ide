import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { Toaster, Toast, toast, dismiss } from '../components/toaster';
import { Button } from '../components/button';

const meta = {
  title: 'Example/Toaster',
  component: Toast,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    notification: {
      control: 'object',
      description: 'The notification configuration object',
    },
  },
  args: {
    onDismiss: fn(),
  },
  decorators: [
    (Story) => (
      <div className="relative p-4">
        <Toaster position="bottom-right" />
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default toast stories (neutral styling)
export const Default: Story = {
  args: {
    notification: {
      id: 'default-1',
      title: 'Notification',
      message: 'This is a default toast with neutral styling.',
      actions: [{ label: 'OK', type: 'primary', onClick: fn() }],
    },
  },
};

export const DefaultWithMultipleActions: Story = {
  args: {
    notification: {
      id: 'default-2',
      title: 'Confirm Action',
      message: 'Would you like to proceed?',
      type: 'info',
      actions: [
        { label: 'Confirm', type: 'primary', onClick: fn() },
        { label: 'Cancel', type: 'secondary', onClick: fn() },
      ],
    },
  },
};

export const DefaultNoActions: Story = {
  args: {
    notification: {
      id: 'default-3',
      title: 'Quick Update',
      message: 'Your changes have been saved.',
      type: 'info',
      actions: [],
    },
  },
};

// Semantic type stories
export const InfoToast: Story = {
  args: {
    notification: {
      id: 'info-1',
      title: 'Information',
      message: 'This is an informational toast message.',
      type: 'info',
      actions: [{ label: 'Got it', type: 'primary', onClick: fn() }],
    },
  },
};

export const WarningToast: Story = {
  args: {
    notification: {
      id: 'warning-1',
      title: 'Warning',
      message: 'Something might need your attention.',
      type: 'warning',
      actions: [
        { label: 'Review', type: 'primary', onClick: fn() },
        { label: 'Dismiss', type: 'secondary', onClick: fn() },
      ],
    },
  },
};

export const ErrorToast: Story = {
  args: {
    notification: {
      id: 'error-1',
      title: 'Error',
      message: 'Something went wrong. Please try again.',
      type: 'error',
      actions: [
        { label: 'Retry', type: 'destructive', onClick: fn() },
        { label: 'Cancel', type: 'secondary', onClick: fn() },
      ],
    },
  },
};

export const WithMultipleActions: Story = {
  args: {
    notification: {
      id: 'multi-1',
      title: 'Confirm Action',
      message: 'Are you sure you want to proceed with this operation?',
      type: 'info',
      actions: [
        { label: 'Confirm', type: 'primary', onClick: fn() },
        { label: 'Skip', type: 'secondary', onClick: fn() },
        { label: 'Cancel', type: 'secondary', onClick: fn() },
      ],
    },
  },
};

export const NoActions: Story = {
  args: {
    notification: {
      id: 'no-actions-1',
      title: 'Heads up!',
      message: 'This toast will dismiss automatically.',
      type: 'info',
      actions: [],
    },
  },
};

export const LongMessage: Story = {
  args: {
    notification: {
      id: 'long-1',
      title: 'Important Notice',
      message:
        'This is a much longer message that demonstrates how the toast handles extended content. It should wrap nicely within the maximum width constraint.',
      type: 'warning',
      actions: [{ label: 'Acknowledge', type: 'primary', onClick: fn() }],
    },
  },
};

export const TitleOnly: Story = {
  args: {
    notification: {
      id: 'title-only-1',
      title: 'Quick notification',
      message: null,
      type: 'info',
      actions: [{ label: 'OK', type: 'primary', onClick: fn() }],
    },
  },
};

// Interactive demo that triggers actual toasts
export const InteractiveDemo: Story = {
  args: {
    notification: {
      id: 'demo',
      title: 'Demo Toast',
      message: 'Click the buttons below to see real toasts',
      type: 'info',
      actions: [],
    },
  },
  render: () => {
    let toastCounter = 0;

    const showInfoToast = () => {
      toastCounter++;
      toast({
        id: `info-${toastCounter}`,
        title: 'Information',
        message: 'This is an informational toast.',
        type: 'info',
        duration: 5000,
        actions: [
          {
            label: 'Got it',
            type: 'primary',
            onClick: () => dismiss(`info-${toastCounter}`),
          },
        ],
      });
    };

    const showWarningToast = () => {
      toastCounter++;
      toast({
        id: `warning-${toastCounter}`,
        title: 'Warning',
        message: 'Something might need your attention.',
        type: 'warning',
        duration: 5000,
        actions: [
          {
            label: 'Review',
            type: 'primary',
            onClick: () => dismiss(`warning-${toastCounter}`),
          },
          {
            label: 'Dismiss',
            type: 'secondary',
            onClick: () => dismiss(`warning-${toastCounter}`),
          },
        ],
      });
    };

    const showErrorToast = () => {
      toastCounter++;
      toast({
        id: `error-${toastCounter}`,
        title: 'Error',
        message: 'Something went wrong. Please try again.',
        type: 'error',
        duration: 5000,
        actions: [
          {
            label: 'Retry',
            type: 'destructive',
            onClick: () => dismiss(`error-${toastCounter}`),
          },
          {
            label: 'Cancel',
            type: 'secondary',
            onClick: () => dismiss(`error-${toastCounter}`),
          },
        ],
      });
    };

    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          Click the buttons to trigger real toasts:
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={showInfoToast}>
            Show Info Toast
          </Button>
          <Button variant="warning" onClick={showWarningToast}>
            Show Warning Toast
          </Button>
          <Button variant="destructive" onClick={showErrorToast}>
            Show Error Toast
          </Button>
        </div>
      </div>
    );
  },
};
