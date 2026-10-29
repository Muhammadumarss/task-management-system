import { Schema, model, InferSchemaType, Types } from 'mongoose';
import { followUpPolicySchema } from '../tasks/task.model';

export const REMINDER_STATUSES = ['SCHEDULED', 'ASSIGNED', 'RESOLVED', 'DISMISSED'] as const;

const reminderSchema = new Schema(
  {
    personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
    sourceTaskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: REMINDER_STATUSES, default: 'SCHEDULED' },
    reason: { type: String, enum: ['AFTER_WORK', 'REPEAT', 'UNREACHABLE_RETRY'], required: true },
    attempt: { type: Number, default: 1 },
    // Policy carried from the source task so the follow-up chain uses the same rules.
    policy: { type: followUpPolicySchema, required: true },
    assignedTaskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    resolvedAt: { type: Date, default: null },
    outcome: { type: String, default: null },
    dismissedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dismissalReason: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'reminders' },
);

reminderSchema.index({ status: 1, dueAt: 1 });
// One reminder per task completion.
reminderSchema.index({ sourceTaskId: 1 }, { unique: true });
reminderSchema.index({ personId: 1, createdAt: -1 });

export type ReminderDoc = InferSchemaType<typeof reminderSchema> & { _id: Types.ObjectId };
export const Reminder = model('Reminder', reminderSchema);
