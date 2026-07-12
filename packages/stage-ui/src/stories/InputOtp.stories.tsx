import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { InputOtp } from '../components/input-otp';

const meta = {
  title: 'Example/InputOtp',
  component: InputOtp,
  parameters: {},
  tags: ['autodocs'],
  argTypes: {
    length: { control: 'number' },
    disabled: { control: 'boolean' },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
  args: { onChange: fn() },
} satisfies Meta<typeof InputOtp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    length: 6,
  },
};

export const FourDigits: Story = {
  args: {
    length: 4,
  },
};

export const Small: Story = {
  args: {
    length: 6,
    size: 'sm',
  },
};

export const Medium: Story = {
  args: {
    length: 6,
    size: 'md',
  },
};

export const Large: Story = {
  args: {
    length: 6,
    size: 'lg',
  },
};

export const Disabled: Story = {
  args: {
    length: 6,
    disabled: true,
  },
};

export const WithValue: Story = {
  args: {
    length: 6,
    value: '123',
  },
};
