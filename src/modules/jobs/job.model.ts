import { Schema, model, InferSchemaType, Types } from 'mongoose';

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'QUARANTINED'] as const;

const jobSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    // Unique occurrence key (e.g. "backup:scheduled:2026-10-27") so schedules are created idempotently.
    uniqueKey: { type: String, default: undefined },
    runAt: { type: Date, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    leaseOwner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'jobs' },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, leaseUntil: 1 });
jobSchema.index({ uniqueKey: 1 }, { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' } } });

export type JobDoc = InferSchemaType<typeof jobSchema> & { _id: Types.ObjectId };
export const Job = model('Job', jobSchema);
