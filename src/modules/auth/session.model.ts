import { Schema, model, InferSchemaType, Types } from 'mongoose';

const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    csrfHash: { type: String, default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    client: { type: String, enum: ['web', 'mobile'], required: true },
    createdAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: 'sessions' },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Cleanup only. Expiry is always enforced in application logic, because TTL deletion is asynchronous.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const Session = model('Session', sessionSchema);
