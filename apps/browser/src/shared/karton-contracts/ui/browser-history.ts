export type HistoryEntry = {
  url: string;
  title: string;
  faviconUrls: string[];
  lastVisitedAt: Date;
};

/** Suggestions returned by getOmniboxSuggestions */
export type OmniboxSuggestions = {
  /** History entries matching the input */
  historyEntries: {
    url: string;
    title: string;
    visitCount: number;
    lastVisitTime: Date;
    faviconUrl: string | null;
  }[];
  /** Most visited origins grouped by scheme://host[:port] (for empty-input defaults) */
  mostVisitedOrigins: {
    origin: string;
    visitCount: number;
    lastVisitTime: Date;
    faviconUrl: string | null;
  }[];
  /** Previous search terms matching the input */
  searchTerms: {
    term: string;
    /** The search engine keyword used (if available) */
    keyword?: string;
  }[];
  /** Locally running pages (dev servers) sorted by visit frequency then port */
  localPorts: {
    port: number;
    url: string;
    visitCount: number;
    lastVisitTime: Date | null;
    lastTitle: string | null;
    faviconUrl: string | null;
  }[];
};

export type PlanEntry = {
  name: string;
  description: string | null;
  filename: string;
  totalTasks: number;
  completedTasks: number;
  taskGroups: Array<{
    label: string;
    tasks: Array<{ text: string; completed: boolean; depth: number }>;
  }>;
};

export type LogChannelEntry = {
  filename: string;
  byteSize: number;
  lineCount: number;
  tailLines: string[];
};
