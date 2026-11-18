import { z } from 'zod';
import {
  aiTaskSchema,
  assignPlotNodeGroupRequestSchema,
  confirmDerivationCandidateRequestSchema,
  createDerivationCandidateRequestSchema,
  createDerivationSessionRequestSchema,
  createPlotGroupRequestSchema,
  createPlotLinkRequestSchema,
  createPlotNodeRequestSchema,
  createPlotTreeRequestSchema,
  derivationCandidateSchema,
  derivationSessionSchema,
  derivationStepSchema,
  exportPlotTreeSchema,
  importPlotTreeRequestSchema,
  movePlotNodeRequestSchema,
  plotGroupSchema,
  plotLinkSchema,
  plotNodeSchema,
  plotTreeResponseSchema,
  plotTreeSchema,
  updateDerivationSessionRequestSchema,
  updateDerivationStepRequestSchema,
  updatePlotGroupRequestSchema,
  updatePlotNodeRequestSchema,
  updatePlotPositionsRequestSchema,
  updatePlotTreeRequestSchema,
  type PlotGroup,
  type PlotLink,
  type PlotNode,
  type PlotTree,
  type PlotTreeResponse
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

// 剧情树 / 推衍全部 API 调用，复用 apiRequest（CSRF、错误包络、Zod 输出校验）

const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const root = (workId: string): string => `/api/v1/works/${part(workId)}/plot-tree`;

const nodeResultSchema = z.object({ node: plotNodeSchema, version: z.number().int() });
const deleteNodeResultSchema = z.object({ deleted: z.number().int().nonnegative(), version: z.number().int() });
const positionsResultSchema = z.object({ updated: z.number().int().nonnegative() });
const linkResultSchema = z.object({ link: plotLinkSchema, version: z.number().int() });
const groupResultSchema = z.object({ group: plotGroupSchema, version: z.number().int() });
const versionResultSchema = z.object({ version: z.number().int() });
const sessionResultSchema = z.object({ session: derivationSessionSchema });
const derivationDetailSchema = z.object({
  session: derivationSessionSchema,
  steps: z.array(derivationStepSchema),
  candidates: z.array(derivationCandidateSchema)
});
const stepTaskResultSchema = z.object({ task: aiTaskSchema, session: derivationSessionSchema });
const stepResultSchema = z.object({ step: derivationStepSchema });
const candidateResultSchema = z.object({ candidate: derivationCandidateSchema });
const confirmResultSchema = z.object({ nodes: z.array(plotNodeSchema), version: z.number().int() });

export type PlotNodeResult = { node: PlotNode; version: number };
export type PlotSessionDetail = {
  session: z.output<typeof derivationSessionSchema>;
  steps: Array<z.output<typeof derivationStepSchema>>;
  candidates: Array<z.output<typeof derivationCandidateSchema>>;
};

export interface PlotClient {
  fetchTree(workId: string): Promise<PlotTreeResponse>;
  createTree(workId: string, title?: string): Promise<PlotTreeResponse>;
  updateTree(workId: string, title: string, expectedVersion?: number): Promise<PlotTree>;
  createNode(workId: string, input: z.input<typeof createPlotNodeRequestSchema>): Promise<PlotNodeResult>;
  updateNode(
    workId: string,
    nodeId: string,
    patch: z.input<typeof updatePlotNodeRequestSchema>,
    expectedVersion?: number
  ): Promise<PlotNodeResult>;
  deleteNode(workId: string, nodeId: string): Promise<{ deleted: number; version: number }>;
  moveNode(
    workId: string,
    nodeId: string,
    parentId: string | null,
    siblingOrder?: number,
    expectedVersion?: number
  ): Promise<PlotNodeResult>;
  assignGroup(
    workId: string,
    nodeId: string,
    groupId: string | null,
    expectedVersion?: number
  ): Promise<PlotNodeResult>;
  updatePositions(workId: string, positions: Array<{ node_id: string; x: number; y: number }>): Promise<{ updated: number }>;
  createLink(
    workId: string,
    input: z.input<typeof createPlotLinkRequestSchema>,
    expectedVersion?: number
  ): Promise<{ link: PlotLink; version: number }>;
  deleteLink(workId: string, linkId: string): Promise<{ version: number }>;
  createGroup(
    workId: string,
    input: z.input<typeof createPlotGroupRequestSchema>,
    expectedVersion?: number
  ): Promise<{ group: PlotGroup; version: number }>;
  updateGroup(
    workId: string,
    groupId: string,
    patch: z.input<typeof updatePlotGroupRequestSchema>,
    expectedVersion?: number
  ): Promise<{ group: PlotGroup; version: number }>;
  deleteGroup(workId: string, groupId: string): Promise<{ version: number }>;
  exportTree(workId: string): Promise<z.output<typeof exportPlotTreeSchema>>;
  importTree(workId: string, input: z.input<typeof importPlotTreeRequestSchema>): Promise<PlotTreeResponse>;
  createDerivation(
    workId: string,
    input: z.input<typeof createDerivationSessionRequestSchema>
  ): Promise<{ session: z.output<typeof derivationSessionSchema> }>;
  getDerivation(workId: string, sessionId: string): Promise<PlotSessionDetail>;
  updateDerivation(
    workId: string,
    sessionId: string,
    patch: z.input<typeof updateDerivationSessionRequestSchema>
  ): Promise<{ session: z.output<typeof derivationSessionSchema> }>;
  generateStep(
    workId: string,
    sessionId: string
  ): Promise<{ task: z.output<typeof aiTaskSchema>; session: z.output<typeof derivationSessionSchema> }>;
  updateStep(
    workId: string,
    sessionId: string,
    stepNo: number,
    patch: z.input<typeof updateDerivationStepRequestSchema>
  ): Promise<{ step: z.output<typeof derivationStepSchema> }>;
  createCandidate(
    workId: string,
    sessionId: string,
    input: z.input<typeof createDerivationCandidateRequestSchema>
  ): Promise<{ candidate: z.output<typeof derivationCandidateSchema> }>;
  confirmCandidate(
    workId: string,
    sessionId: string,
    candidateId: string,
    expectedVersion?: number
  ): Promise<{ nodes: PlotNode[]; version: number }>;
  rejectCandidate(
    workId: string,
    sessionId: string,
    candidateId: string
  ): Promise<{ candidate: z.output<typeof derivationCandidateSchema> }>;
}

export const plotClient: PlotClient = {
  fetchTree(workId) {
    return apiRequest(root(workId), plotTreeResponseSchema);
  },
  createTree(workId, title) {
    return apiRequest(root(workId), plotTreeResponseSchema, json('POST', createPlotTreeRequestSchema.parse({ title })));
  },
  updateTree(workId, title, expectedVersion) {
    return apiRequest(root(workId), plotTreeSchema, json('PATCH', updatePlotTreeRequestSchema.parse({
      title, expected_version: expectedVersion
    })));
  },
  createNode(workId, input) {
    return apiRequest(`${root(workId)}/nodes`, nodeResultSchema, json('POST', createPlotNodeRequestSchema.parse(input)));
  },
  updateNode(workId, nodeId, patch, expectedVersion) {
    return apiRequest(`${root(workId)}/nodes/${part(nodeId)}`, nodeResultSchema, json('PATCH', updatePlotNodeRequestSchema.parse({
      ...patch, expected_version: expectedVersion
    })));
  },
  deleteNode(workId, nodeId) {
    return apiRequest(`${root(workId)}/nodes/${part(nodeId)}`, deleteNodeResultSchema, { method: 'DELETE' });
  },
  moveNode(workId, nodeId, parentId, siblingOrder, expectedVersion) {
    return apiRequest(`${root(workId)}/nodes/${part(nodeId)}/parent`, nodeResultSchema, json('PATCH', movePlotNodeRequestSchema.parse({
      parent_id: parentId, sibling_order: siblingOrder, expected_version: expectedVersion
    })));
  },
  assignGroup(workId, nodeId, groupId, expectedVersion) {
    return apiRequest(`${root(workId)}/nodes/${part(nodeId)}/group`, nodeResultSchema, json('PATCH', assignPlotNodeGroupRequestSchema.parse({
      group_id: groupId, expected_version: expectedVersion
    })));
  },
  updatePositions(workId, positions) {
    return apiRequest(`${root(workId)}/positions`, positionsResultSchema, json('PUT', updatePlotPositionsRequestSchema.parse({ positions })));
  },
  createLink(workId, input, expectedVersion) {
    return apiRequest(`${root(workId)}/links`, linkResultSchema, json('POST', createPlotLinkRequestSchema.parse({
      ...input, expected_version: expectedVersion
    })));
  },
  deleteLink(workId, linkId) {
    return apiRequest(`${root(workId)}/links/${part(linkId)}`, versionResultSchema, { method: 'DELETE' });
  },
  createGroup(workId, input, expectedVersion) {
    return apiRequest(`${root(workId)}/groups`, groupResultSchema, json('POST', createPlotGroupRequestSchema.parse({
      ...input, expected_version: expectedVersion
    })));
  },
  updateGroup(workId, groupId, patch, expectedVersion) {
    return apiRequest(`${root(workId)}/groups/${part(groupId)}`, groupResultSchema, json('PATCH', updatePlotGroupRequestSchema.parse({
      ...patch, expected_version: expectedVersion
    })));
  },
  deleteGroup(workId, groupId) {
    return apiRequest(`${root(workId)}/groups/${part(groupId)}`, versionResultSchema, { method: 'DELETE' });
  },
  exportTree(workId) {
    return apiRequest(`${root(workId)}/export`, exportPlotTreeSchema);
  },
  importTree(workId, input) {
    return apiRequest(`${root(workId)}/import`, plotTreeResponseSchema, json('POST', importPlotTreeRequestSchema.parse(input)));
  },
  createDerivation(workId, input) {
    return apiRequest(`${root(workId)}/derivations`, sessionResultSchema, json('POST', createDerivationSessionRequestSchema.parse(input)));
  },
  getDerivation(workId, sessionId) {
    return apiRequest(`${root(workId)}/derivations/${part(sessionId)}`, derivationDetailSchema);
  },
  updateDerivation(workId, sessionId, patch) {
    return apiRequest(`${root(workId)}/derivations/${part(sessionId)}`, sessionResultSchema, json('PATCH', updateDerivationSessionRequestSchema.parse(patch)));
  },
  generateStep(workId, sessionId) {
    return apiRequest(
      `${root(workId)}/derivations/${part(sessionId)}/steps`,
      stepTaskResultSchema,
      { method: 'POST' }
    );
  },
  updateStep(workId, sessionId, stepNo, patch) {
    return apiRequest(
      `${root(workId)}/derivations/${part(sessionId)}/steps/${stepNo}`,
      stepResultSchema,
      json('PATCH', updateDerivationStepRequestSchema.parse(patch))
    );
  },
  createCandidate(workId, sessionId, input) {
    return apiRequest(
      `${root(workId)}/derivations/${part(sessionId)}/candidates`,
      candidateResultSchema,
      json('POST', createDerivationCandidateRequestSchema.parse(input))
    );
  },
  confirmCandidate(workId, sessionId, candidateId, expectedVersion) {
    return apiRequest(
      `${root(workId)}/derivations/${part(sessionId)}/candidates/${part(candidateId)}/confirm`,
      confirmResultSchema,
      json('POST', confirmDerivationCandidateRequestSchema.parse({ expected_version: expectedVersion }))
    );
  },
  rejectCandidate(workId, sessionId, candidateId) {
    return apiRequest(
      `${root(workId)}/derivations/${part(sessionId)}/candidates/${part(candidateId)}/reject`,
      candidateResultSchema,
      { method: 'POST' }
    );
  }
};
