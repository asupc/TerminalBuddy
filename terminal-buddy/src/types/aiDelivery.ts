export interface AiQualityGate {
  commands: string[];
}

export interface AiRepository {
  id: string;
  name: string;
  relativePath: string;
  defaultBranch: string;
  writeConcurrency: number;
  writeEnabled: boolean;
}

export interface AiProject {
  id: string;
  name: string;
  workspaceRoot: string;
  repositories: AiRepository[];
  worktreeRoot?: string | null;
  qualityGate: AiQualityGate;
  managerAgentId?: string | null;
  maxConcurrency: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiProjectInput {
  name: string;
  workspaceRoot: string;
  profileId?: string | null;
  worktreeRoot?: string | null;
  qualityGate: AiQualityGate;
  managerAgentId?: string | null;
  maxConcurrency: number;
}

export interface AiRuntimeProbe {
  kind: 'codex' | 'claude' | 'opencode' | 'hermes' | 'pi' | 'mimo' | 'kimi' | string;
  command: string;
  available: boolean;
  version?: string | null;
}

export interface AiStartupPreset {
  id: string;
  name: string;
  promptPrefix: string;
  modelArgs?: Record<string, unknown> | null;
  contextStrategy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAgentRuntime {
  id: string;
  name: string;
  kind: string;
  command: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiAgent {
  id: string;
  name: string;
  runtimeId: string;
  runtimeArgs: string[];
  startupPresetName?: string | null;
  /** 兜底默认超时（秒），None 时使用全局默认。 */
  defaultTimeoutSeconds?: number | null;
  maxConcurrency: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiRole {
  id: string;
  name: string;
  description: string;
  candidateAgentIds: string[];
  lockedAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiWorkflowStep {
  id: string;
  name: string;
  roleId?: string | null;
  /** 仅用于兼容旧编排；新步骤由角色决定执行 Agent。 */
  agentId?: string;
  executionMode: 'write' | 'readonly';
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  prompt: string;
}

export interface AiWorkflow {
  id: string;
  name: string;
  description: string;
  steps: AiWorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskContractInput {
  projectId: string;
  deliveryId: string;
  taskId: string;
  title: string;
  targetRepositoryId: string;
  allowedWritePaths: string[];
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  inputArtifacts?: string[];
  acceptanceCommands?: string[];
  expectedArtifacts?: string[];
  retryCount?: number;
}

export interface CreateAiDeliveryInput {
  projectId: string;
  title: string;
  requirement: string;
  managerAgentId?: string | null;
  workflowId?: string | null;
}

export interface UpdateAiDeliveryInput {
  id: string;
  title: string;
  requirement: string;
  managerAgentId?: string | null;
  workflowId?: string | null;
}

export interface UpdateAiTaskNodeInput {
  id: string;
  title?: string;
  description?: string;
  roleId?: string | null;
  preferredAgentId?: string | null;
  taskPrompt?: string;
  executionMode?: 'write' | 'readonly';
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  targetRepositoryId?: string;
  allowedWritePaths?: string[];
  dependencyIds?: string[];
  expectedArtifacts?: string[];
  acceptanceCommands?: string[];
  timeoutSeconds?: number | null;
  retryCount?: number;
}

export interface CreateAiTaskNodeInput {
  deliveryId: string;
  title: string;
  description: string;
  roleId?: string | null;
  workflowStepId?: string | null;
  preferredAgentId?: string | null;
  taskPrompt?: string;
  executionMode?: 'write' | 'readonly';
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  targetRepositoryId: string;
  allowedWritePaths: string[];
  dependencyIds?: string[];
  inputArtifacts?: string[];
  expectedArtifacts?: string[];
  acceptanceCommands?: string[];
  retryCount?: number;
  /** 超时（秒），留空使用 Agent 默认 */
  timeoutSeconds?: number | null;
}

export interface AiTaskContract {
  id: string;
  projectId: string;
  deliveryId: string;
  taskId: string;
  title: string;
  targetRepositoryId: string;
  targetRepositoryName: string;
  allowedWritePaths: string[];
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  forbiddenRepositoryIds: string[];
  inputArtifacts: string[];
  inputArtifactDirectory?: string | null;
  outputArtifactDirectory?: string | null;
  acceptanceCommands: string[];
  expectedArtifacts: string[];
  retryCount: number;
  state: 'planned' | 'allocated' | string;
  branchName?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  validatedCommit?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiDelivery {
  id: string;
  projectId: string;
  title: string;
  requirement: string;
  managerAgentId?: string | null;
  workflowId?: string | null;
  workflowName?: string | null;
  workflowSteps: AiWorkflowStep[];
  state: string;
  taskNodeIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AiTaskNode {
  id: string;
  deliveryId: string;
  title: string;
  description: string;
  roleId?: string | null;
  workflowStepId?: string | null;
  preferredAgentId?: string | null;
  taskPrompt: string;
  executionMode: 'write' | 'readonly';
  executionContext?: 'workspaceRoot' | 'taskWorktree';
  targetRepositoryId: string;
  allowedWritePaths: string[];
  dependencyIds: string[];
  inputArtifacts: string[];
  expectedArtifacts: string[];
  acceptanceCommands: string[];
  retryCount: number;
  /** 单次执行超时（秒），留空使用 Agent 默认值。 */
  timeoutSeconds?: number | null;
  state: string;
  assignedAgentId?: string | null;
  contractId?: string | null;
  attemptIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AiAttempt {
  id: string;
  deliveryId: string;
  taskNodeId: string;
  contractId: string;
  agentId: string;
  runtimeId: string;
  terminalId?: string | null;
  state: string;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAttemptReview {
  approved: boolean;
  comments: string;
}

export interface AiAttemptDecision {
  question: string;
  impact: string;
  options: AiDecisionOption[];
}

export interface AiAttemptOutput {
  attemptId: string;
  transcriptTail: string;
  finalMessage?: string | null;
  review?: AiAttemptReview | null;
  decision?: AiAttemptDecision | null;
  promptExcerpt?: string | null;
  planJson?: string | null;
  /** attempt 是否仍在运行（Web 端轮询实时状态用） */
  isLive: boolean;
  /** live-output.log 尾部（最多 8000 字符），Web 端轮询用 */
  liveOutputTail: string;
}

export interface AiArtifactMeta {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface AiCommandResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface AiReviewGate {
  id: string;
  deliveryId: string;
  taskNodeId: string;
  reviewerAgentId?: string | null;
  state: string;
  comments?: string | null;
  commandResults: AiCommandResult[];
  lineComments?: Array<{ path: string; line: number; text: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface AiReviewDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface AiReviewDiffContent {
  path: string;
  original: string;
  modified: string;
}

export interface AiReviewDiffResult {
  baseCommit: string;
  headCommit: string;
  files: AiReviewDiffFile[];
  diffs: AiReviewDiffContent[];
}

export interface AiDecisionOption {
  label: string;
  description: string;
}

export interface AiDecisionRequest {
  id: string;
  deliveryId: string;
  taskNodeId?: string | null;
  question: string;
  impact: string;
  options: AiDecisionOption[];
  state: string;
  answer?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiDecisionRequestInput {
  deliveryId: string;
  taskNodeId?: string | null;
  question: string;
  impact: string;
  options?: AiDecisionOption[];
}

export interface AiDeliveryEvent {
  id: string;
  deliveryId: string;
  taskNodeId?: string | null;
  attemptId?: string | null;
  eventType: string;
  message: string;
  occurredAt: string;
}

export interface AiMergeRepositoryRecord {
  repositoryId: string;
  branchName: string;
  preMergeHead: string;
  mergedHead?: string | null;
  state: string;
  error?: string | null;
}

export interface AiMergeRecord {
  id: string;
  deliveryId: string;
  projectId: string;
  state: string;
  repositories: AiMergeRepositoryRecord[];
  createdAt: string;
  updatedAt: string;
}

