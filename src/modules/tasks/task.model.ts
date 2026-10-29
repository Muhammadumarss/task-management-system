import { Schema, model, InferSchemaType, Types } from 'mongoose';

export const TASK_TYPES = ['WORK', 'FOLLOW_UP'] as const;
export const TASK_STATUSES = ['ASSIGNED', 'COMPLETED', 'CANCELLED'] as const;
export const FOLLOW_UP_OUTCOMES = ['NEEDS_WORK', 'NO_WORK_NEEDED', 'UNREACHABLE'] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

export const followUpPolicySchema = new Schema(
  {
    enabled: { type: Boolean, required: true },
    intervalDays: { type: Number, required: true },
    reminderTime: { type: String, required: true }, // HH:mm, business timezone
    repeatFollowUps: { type: Boolean, required: true },
    unreachableRetryDays: { type: Number, required: true },
    maxUnreachableAttempts: { type: Number, required: true },
    timezone: { type: String, required: true },
  },
  { _id: false },
);

const taskSchema = new Schema(
  {
    personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
    type: { type: String, enum: TASK_TYPES, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    scheduledDate: { type: String, required: true }, // YYYY-MM-DD
    instructions: { type: String, default: '' },
    status: { type: String, enum: TASK_STATUSES, default: 'ASSIGNED' },
    sourceReminderId: { type: Schema.Types.ObjectId, ref: 'Reminder', default: undefined },
    // For FOLLOW_UP tasks: how many unreachable attempts preceded this one.
    attempt: { type: Number, default: 1 },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    completionNotes: { type: String, default: null },
    followUpOutcome: { type: String, enum: [...FOLLOW_UP_OUTCOMES, null], default: null },
    adminOverrideReason: { type: String, default: null },
    outcomeReviewedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancellationReason: { type: String, default: null },
    needsReassignment: { type: Boolean, default: false },
    followUpPolicySnapshot: { type: followUpPolicySchema, required: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'tasks' },
);

taskSchema.index({ assignedTo: 1, status: 1, scheduledDate: 1 });
taskSchema.index({ personId: 1, createdAt: -1 });
taskSchema.index({ status: 1, scheduledDate: 1 });
// One open follow-up task per reminder. Scoped to ASSIGNED so a cancelled follow-up whose
// reminder was rescheduled can be assigned again.
taskSchema.index(
  { sourceReminderId: 1 },
  {
    unique: true,
    name: 'uniq_open_task_per_reminder',
    partialFilterExpression: { sourceReminderId: { $exists: true }, status: 'ASSIGNED' },
  },
);

export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: Types.ObjectId };
export const Task = model('Task', taskSchema);
