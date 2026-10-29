import { Schema, model } from 'mongoose';

const auditSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    // Safe summary only: field names changed, reasons, state transitions. No customer details.
    summary: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null },
    timestamp: { type: Date, required: true },
  },
  { versionKey: false, collection: 'auditLogs' },
);

auditSchema.index({ timestamp: -1 });
auditSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
auditSchema.index({ actorId: 1, timestamp: -1 });
auditSchema.index({ action: 1, timestamp: -1 });

export const AuditLog = model('AuditLog', auditSchema);
