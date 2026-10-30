export type Metadata = { tags: string[]; group: string }
export type NoteSummary = { path: string; title: string; metadata: Metadata; revision: string; modified: string; metadataError?: string }
export type Note = NoteSummary & { content: string }
export type TreeEntry = { path: string; name: string; type: 'folder' | 'note' | 'drawing'; children?: TreeEntry[] }
export type Drawing = { path: string; revision: string; modified: string; content: string; markdownPath?: string }
export type UIStyle = 'sage' | 'paper' | 'mono' | 'soft' | 'glass' | 'ink'
export type NoteWidth = 'default' | 'medium' | 'large'
export type Settings = { theme: 'light' | 'dark' | 'system'; uiStyle: UIStyle; accent: string; animations: boolean; editorFontSize: number; editorLineNumbers: boolean; previewLineNumbers: boolean; multiTabs: boolean; sourceSplitPreview: boolean; strictLineBreaks: boolean; noteWidth: NoteWidth; assetsDir: string; scanExcludes: string[]; shortcuts: Record<string, string> }
export type SettingsPreview = Pick<Settings, 'theme' | 'uiStyle' | 'accent' | 'editorFontSize'>
export type StorageUsage = { root: string; assetsDir: string; databaseBytes: number; noteBytes: number; noteCount: number; assetBytes: number; assetCount: number }
export type UnusedAssets = { assetsDir: string; files: { path: string; size: number }[]; bytes: number; token: string }
export type AssetCleanup = { removedCount: number; removedBytes: number; failed: string[] }
export type Task = { id: string; notePath: string; noteTitle: string; line: number; text: string; status: 'todo' | 'doing' | 'done'; due?: string; remindAt?: string; repeat?: 'none' | 'daily' | 'weekly' | 'monthly'; timezone?: string; revision: string }
export type PlanRepeat = 'once' | 'daily' | 'weekly'
export type Plan = { id: string; title: string; note?: string; repeat: PlanRepeat; date?: string; time: string; weekdays?: number[]; timezone?: string; enabled: boolean; createdAt: string; updatedAt: string }
export type PlanDraft = { id?: string; title: string; note?: string; repeat: PlanRepeat; date?: string; time: string; weekdays?: number[]; timezone?: string; enabled: boolean }
export type CustomTask = { id: string; text: string; description?: string; status: 'todo' | 'doing' | 'done'; createdAt: string; updatedAt: string }
export type CustomTaskDraft = { id?: string; text: string; description?: string; status: CustomTask['status'] }
export type Reminder = { id: string; planId?: string; taskId?: string; notePath?: string; text: string; due: string; acknowledged: boolean }
export type TrashEntry = { id: string; path: string; deletedAt: string }
export type Repository = { path: string; name: string; lastOpened: string }
export type RepositoryList = { current: string; items: Repository[]; switched: boolean; canceled: boolean }
export type ExportSnapshot = { notes: (Note & { assets: Record<string, string> })[]; missing: string[]; external: string[] }
export type AgentMode = 'note' | 'chat'
export type AgentConfig = { enabled: boolean; baseURL: string; hasKey: boolean; apiKeyHint: string; model: string; contextTokens: number; maxOutputTokens: number; temperature: number; systemPrompt: string; timeoutSeconds: number }
export type AgentConfigInput = { enabled: boolean; baseURL: string; apiKey: string; model: string; contextTokens: number; maxOutputTokens: number; temperature: number; systemPrompt: string; timeoutSeconds: number }
export type Conversation = { id: string; title: string; mode: AgentMode; notePath: string; createdAt: string; updatedAt: string }
export type AgentToolCall = { id: string; name: string; arguments: string }
export type AgentMessage = { id: string; conversationId: string; role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: AgentToolCall[]; toolCallId?: string; outcome?: '' | 'accepted' | 'rejected'; createdAt: string }
export type AnnotationStroke = { points: [number, number][]; width: number }
export type AnnotationHighlight = { start: number; end: number; quote: string }
export type Annotation = {
  id: string
  notePath: string
  kind: 'stroke' | 'highlight'
  anchorLine: number
  anchorText: string
  color: string
  data: AnnotationStroke | AnnotationHighlight
  comment: string
  createdAt: string
  updatedAt: string
}
export type AnnotationList = { visible: boolean; items: Annotation[] }
export type AgentEvent =
  | { type: 'meta'; conversationId: string; title: string; userMessageId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_delta'; id: string; arguments: string }
  | { type: 'tool_end'; id: string; name: string; arguments: string }
  | { type: 'done'; conversationId?: string; messageId: string }
  | { type: 'error'; error: string; conversationId?: string; messageId?: string }
