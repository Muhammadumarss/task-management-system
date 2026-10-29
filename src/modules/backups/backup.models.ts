import { Schema, model, InferSchemaType, Types } from 'mongoose';

const backupRunSchema = new Schema(
  {
    status: { type: String, enum: ['RUNNING', 'SUCCEEDED', 'FAILED'], required: true },
    trigger: { type: String, enum: ['SCHEDULED', 'MANUAL'], required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', default: null },
    // Present only while RUNNING; unique index makes it a mutual-exclusion lock.
    activeLock: { type: String, default: undefined },
    heartbeatAt: { type: Date, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    method: { type: String, default: null },
    format: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    checksumSha256: { type: String, default: null },
    keyId: { type: String, default: null },
    collections: { type: Schema.Types.Mixed, default: null }, // { name: count }
    driveFileId: { type: String, default: null },
    deletedFromDriveAt: { type: Date, default: null },
    errorSummary: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'backupRuns' },
);

backupRunSchema.index({ activeLock: 1 }, { unique: true, partialFilterExpression: { activeLock: { $type: 'string' } } });
backupRunSchema.index({ status: 1, startedAt: -1 });

export type BackupRunDoc = InferSchemaType<typeof backupRunSchema> & { _id: Types.ObjectId };
export const BackupRun = model('BackupRun', backupRunSchema);

const driveIntegrationSchema = new Schema(
  {
    _id: { type: String, default: 'drive' },
    status: { type: String, enum: ['DISCONNECTED', 'PENDING', 'CONNECTED', 'NEEDS_RECONNECT'], default: 'DISCONNECTED' },
    oauthStateHash: { type: String, default: null },
    oauthStateExpiresAt: { type: Date, default: null },
    oauthStartedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    encryptedRefreshToken: { type: String, default: null, select: false },
    folderId: { type: String, default: null },
    accountEmail: { type: String, default: null },
    connectedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'driveIntegration' },
);

export const DriveIntegration = model('DriveIntegration', driveIntegrationSchema);
