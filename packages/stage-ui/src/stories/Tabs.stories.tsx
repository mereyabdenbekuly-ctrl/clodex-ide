import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/tabs';
import { HomeIcon, SettingsIcon, UserIcon } from 'lucide-react';

const meta = {
  title: 'Example/Tabs',
  component: Tabs,
  parameters: {},
  tags: ['autodocs'],
  args: { onValueChange: fn() },
  render: (args) => (
    <Tabs {...args}>
      <TabsList className="grid-cols-3">
        <TabsTrigger value="home">
          <HomeIcon className="mr-1.5 size-4" />
          Home
        </TabsTrigger>
        <TabsTrigger value="profile">
          <UserIcon className="mr-1.5 size-4" />
          Profile
        </TabsTrigger>
        <TabsTrigger value="settings">
          <SettingsIcon className="mr-1.5 size-4" />
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="home">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <h2 className="mb-2 font-semibold text-lg">Home</h2>
          <p className="text-sm">Welcome to the home tab!</p>
        </div>
      </TabsContent>
      <TabsContent value="profile">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <h2 className="mb-2 font-semibold text-lg">Profile</h2>
          <p className="text-sm">Your profile information goes here.</p>
        </div>
      </TabsContent>
      <TabsContent value="settings">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <h2 className="mb-2 font-semibold text-lg">Settings</h2>
          <p className="text-sm">Adjust your settings here.</p>
        </div>
      </TabsContent>
    </Tabs>
  ),
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    defaultValue: 'home',
  },
};

export const TextOnly: Story = {
  args: {
    defaultValue: 'overview',
  },
  render: (args) => (
    <Tabs {...args}>
      <TabsList className="grid-cols-4">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
        <TabsTrigger value="notifications">Notifications</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <p className="text-sm">Overview content</p>
        </div>
      </TabsContent>
      <TabsContent value="analytics">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <p className="text-sm">Analytics content</p>
        </div>
      </TabsContent>
      <TabsContent value="reports">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <p className="text-sm">Reports content</p>
        </div>
      </TabsContent>
      <TabsContent value="notifications">
        <div className="rounded-lg border border-border/20 bg-white/40 p-4">
          <p className="text-sm">Notifications content</p>
        </div>
      </TabsContent>
    </Tabs>
  ),
};
