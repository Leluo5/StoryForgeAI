import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import type {
  CreateCommentRequest,
  CreateRevisionSetRequest,
  CreateTodoRequest,
  CreateVersionRequest,
  CompareVersionsRequest,
  ListAuditLogsQuery,
  ListNotificationsQuery,
  ListRevisionSetsQuery,
  ListTodosQuery,
  ListVersionsQuery,
  ReAnchorCommentRequest,
  ReplyCommentRequest,
  ResolveOperationRequest,
  UpdateTodoStatusRequest
} from '@storyforge/contracts';
import {
  compareVersionsRequestSchema,
  createCommentRequestSchema,
  createRevisionSetRequestSchema,
  createTodoRequestSchema,
  createVersionRequestSchema,
  listAuditLogsQuerySchema,
  listNotificationsQuerySchema,
  listRevisionSetsQuerySchema,
  listTodosQuerySchema,
  listVersionsQuerySchema,
  reAnchorCommentRequestSchema,
  replyCommentRequestSchema,
  resolveOperationRequestSchema,
  updateTodoStatusRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { RevisionService } from './revision.service';
import { VersionService } from './version.service';
import { CommentService } from './comment.service';
import { TodoService } from './todo.service';
import { NotificationService } from './notification.service';
import { AuditService } from './audit.service';

// ───────────────────────────── 3.1 修订集 ─────────────────────────────

@Controller('works/:workId')
@UseGuards(SessionGuard)
export class RevisionController {
  constructor(
    @Inject(RevisionService) private readonly revisionService: RevisionService,
    @Inject(VersionService) private readonly versionService: VersionService,
    @Inject(CommentService) private readonly commentService: CommentService,
    @Inject(TodoService) private readonly todoService: TodoService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  // ── 修订集 ──

  @Post('chapters/:chapterId/revision-sets')
  @UseGuards(CsrfGuard)
  async createRevisionSet(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(createRevisionSetRequestSchema)) input: CreateRevisionSetRequest
  ) {
    return ok(request, await this.revisionService.createRevisionSet(request.author.id, workId, chapterId, input));
  }

  @Get('chapters/:chapterId/revision-sets')
  async listRevisionSets(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Query(new ZodValidationPipe(listRevisionSetsQuerySchema)) query: ListRevisionSetsQuery
  ) {
    return ok(request, await this.revisionService.listRevisionSets(request.author.id, workId, chapterId, query));
  }

  @Post('revision-sets/:revisionSetId/operations/:opIndex/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async acceptOperation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('revisionSetId') revisionSetId: string,
    @Param('opIndex', ParseIntPipe) opIndex: number,
    @Body(new ZodValidationPipe(resolveOperationRequestSchema)) input: ResolveOperationRequest
  ) {
    return ok(request, await this.revisionService.resolveOperation(request.author.id, workId, revisionSetId, opIndex, 'accept'));
  }

  @Post('revision-sets/:revisionSetId/operations/:opIndex/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async rejectOperation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('revisionSetId') revisionSetId: string,
    @Param('opIndex', ParseIntPipe) opIndex: number,
    @Body(new ZodValidationPipe(resolveOperationRequestSchema)) input: ResolveOperationRequest
  ) {
    return ok(request, await this.revisionService.resolveOperation(request.author.id, workId, revisionSetId, opIndex, 'reject'));
  }

  // ── 版本快照与回滚 ──

  @Post('chapters/:chapterId/versions')
  @UseGuards(CsrfGuard)
  async createVersion(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(createVersionRequestSchema)) input: CreateVersionRequest
  ) {
    return ok(request, await this.versionService.createVersion(request.author.id, workId, chapterId, input));
  }

  @Get('chapters/:chapterId/versions')
  async listVersions(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Query(new ZodValidationPipe(listVersionsQuerySchema)) query: ListVersionsQuery
  ) {
    return ok(request, await this.versionService.listVersions(request.author.id, workId, chapterId, query));
  }

  @Get('chapters/:chapterId/versions/:versionNo')
  async getVersion(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Param('versionNo', ParseIntPipe) versionNo: number
  ) {
    return ok(request, await this.versionService.getVersion(request.author.id, workId, chapterId, versionNo));
  }

  @Post('chapters/:chapterId/versions/:versionNo/compare')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async compareVersions(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Param('versionNo', ParseIntPipe) _versionNo: number,
    @Body(new ZodValidationPipe(compareVersionsRequestSchema)) input: CompareVersionsRequest
  ) {
    return ok(request, await this.versionService.compareVersions(request.author.id, workId, chapterId, input));
  }

  @Post('chapters/:chapterId/versions/:versionNo/rollback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async rollback(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Param('versionNo', ParseIntPipe) versionNo: number
  ) {
    return ok(request, await this.versionService.rollback(request.author.id, workId, chapterId, versionNo));
  }

  @Post('revision-sets/:revisionSetId/confirm-rollback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async confirmRollback(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('revisionSetId') revisionSetId: string
  ) {
    return ok(request, await this.versionService.confirmRollback(request.author.id, workId, revisionSetId));
  }

  // ── 评论 ──

  @Post('chapters/:chapterId/comments')
  @UseGuards(CsrfGuard)
  async createComment(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(createCommentRequestSchema)) input: CreateCommentRequest
  ) {
    return ok(request, await this.commentService.createComment(request.author.id, workId, chapterId, input));
  }

  @Get('chapters/:chapterId/comments')
  async listComments(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string
  ) {
    return ok(request, await this.commentService.listComments(request.author.id, workId, chapterId));
  }

  @Post('comments/:commentId/replies')
  @UseGuards(CsrfGuard)
  async replyComment(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(replyCommentRequestSchema)) input: ReplyCommentRequest
  ) {
    return ok(request, await this.commentService.replyComment(request.author.id, workId, commentId, input));
  }

  @Post('comments/:commentId/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async resolveComment(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('commentId') commentId: string
  ) {
    return ok(request, await this.commentService.resolveComment(request.author.id, workId, commentId));
  }

  @Post('comments/:commentId/reopen')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async reopenComment(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('commentId') commentId: string
  ) {
    return ok(request, await this.commentService.reopenComment(request.author.id, workId, commentId));
  }

  @Post('comments/:commentId/re-anchor')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async reAnchorComment(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(reAnchorCommentRequestSchema)) input: ReAnchorCommentRequest
  ) {
    return ok(request, await this.commentService.reAnchorComment(request.author.id, workId, commentId, input));
  }

  // ── 待办 ──

  @Post('todos')
  @UseGuards(CsrfGuard)
  async createTodo(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createTodoRequestSchema)) input: CreateTodoRequest
  ) {
    return ok(request, await this.todoService.createTodo(request.author.id, workId, input));
  }

  @Get('todos')
  async listTodos(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query(new ZodValidationPipe(listTodosQuerySchema)) query: ListTodosQuery
  ) {
    return ok(request, await this.todoService.listTodos(request.author.id, workId, query));
  }

  @Patch('todos/:todoId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async updateTodoStatus(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('todoId') todoId: string,
    @Body(new ZodValidationPipe(updateTodoStatusRequestSchema)) input: UpdateTodoStatusRequest
  ) {
    return ok(request, await this.todoService.updateStatus(request.author.id, workId, todoId, input.status));
  }

  @Post('comments/:commentId/todo')
  @UseGuards(CsrfGuard)
  async commentToTodo(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(createTodoRequestSchema)) input: CreateTodoRequest
  ) {
    return ok(request, await this.todoService.commentToTodo(request.author.id, workId, commentId, input));
  }

  // ── 审计（作品内只读） ──

  @Get('audit-logs')
  async listAuditLogs(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery
  ) {
    return ok(request, await this.auditService.query(workId, query));
  }
}

// ───────────────────────────── 3.5 通知（个人维度，不含 workId 路径） ─────────────────────────────

@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly service: NotificationService) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery
  ) {
    return ok(request, await this.service.list(request.author.id, query));
  }

  @Get('unread-count')
  async unreadCount(@Req() request: AuthenticatedRequest) {
    return ok(request, await this.service.unreadCount(request.author.id));
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async markRead(
    @Req() request: AuthenticatedRequest,
    @Param('notificationId') notificationId: string
  ) {
    return ok(request, await this.service.markRead(request.author.id, notificationId));
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async markAllRead(@Req() request: AuthenticatedRequest) {
    return ok(request, await this.service.markAllRead(request.author.id));
  }
}
