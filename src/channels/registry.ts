import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Reset session for a group (start fresh conversation) */
  resetSession?: (groupFolder: string) => void;
  /** Get container status for a group JID */
  getGroupStatus?: (groupJid: string) => {
    active: boolean;
    idleWaiting: boolean;
    isTaskContainer: boolean;
    runningTaskId: string | null;
    containerName: string | null;
    pendingTaskCount: number;
  };
  /** Cancel (close) the active container for a group JID */
  cancelContainer?: (groupJid: string) => void;
  /** Get scheduled tasks for a group folder */
  getTasksForGroup?: (groupFolder: string) => import('../types.js').ScheduledTask[];
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
