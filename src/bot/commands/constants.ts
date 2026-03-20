/** Default number of days for digest and decisions lookback window */
export const DEFAULT_LOOKBACK_DAYS = 7;

/** Maximum number of items to display in a single embed */
export const MAX_DISPLAY_ITEMS = 20;

/** Maximum length for an embed description (Discord limit is 4096) */
export const EMBED_DESCRIPTION_MAX_LENGTH = 4000;

/** Maximum length for a single embed field value */
export const EMBED_FIELD_MAX_LENGTH = 256;

/** Milliseconds per day */
export const MS_PER_DAY = 86_400_000;

/** Minimum allowed value for the days parameter */
export const MIN_DAYS_PARAM = 1;

/** Maximum number of search results to display */
export const MAX_SEARCH_RESULTS = 20;

/** Valid entity types for the extraction system */
export const VALID_ENTITY_TYPES = [
  'project',
  'action',
  'question',
  'decision',
  'concept',
  'resource',
] as const;

/** Entity type descriptions for /about command */
export const ENTITY_TYPE_DESCRIPTIONS: Record<string, string> = {
  project: 'A named initiative, product, feature, or workstream being discussed',
  action: 'Something someone committed to doing or was asked to do',
  question: 'A question that was asked — automatically marked resolved if answered',
  decision: 'An explicit decision or agreement the group reached',
  concept: 'A technical concept, architecture pattern, or idea discussed in depth',
  resource: 'A URL, tool, library, or reference that was shared',
} as const;

/** Command descriptions for /help command */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  about: 'Learn what Smithers tracks and how it works',
  help: 'List all available commands',
  actions: 'Show open action items, optionally filtered by assignee',
  questions: 'Show unanswered questions',
  digest: 'Summary of recent activity across all types',
  projects: 'Show active projects',
  decisions: 'Show recent decisions',
  status: 'Bot health — uptime, messages captured, entities extracted',
  search: 'Free-text search across all entity types',
  correct: 'Fix extraction errors (retype, retitle, resolve, delete, merge)',
} as const;

/** Embed colours by command type */
export const EMBED_COLOURS = {
  ACTIONS: 0x5865F2,   // Blurple
  QUESTIONS: 0xEB459E, // Fuchsia
  DIGEST: 0x57F287,    // Green
  PROJECTS: 0xFEE75C,  // Yellow
  DECISIONS: 0xED4245, // Red
  STATUS: 0x5865F2,    // Blurple
  ERROR: 0xED4245,     // Red
  SEARCH: 0x5865F2,    // Blurple
  CORRECT: 0x57F287,   // Green
  ABOUT: 0x5865F2,     // Blurple
  HELP: 0x57F287,      // Green
} as const;

/** Empty-state messages */
export const EMPTY_MESSAGES = {
  ACTIONS: 'No open action items found.',
  QUESTIONS: 'No unanswered questions found.',
  DIGEST: (days: number) => `No activity in the last ${days} days.`,
  PROJECTS: 'No active projects found.',
  DECISIONS: (days: number) => `No recent decisions in the last ${days} days.`,
  SEARCH: 'No entities found matching your query.',
} as const;
